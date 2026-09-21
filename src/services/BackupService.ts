import { sequelize } from '../db';
import * as fs from 'fs';
import * as path from 'path';
import AdmZip from 'adm-zip';
import logger from '../utils/logger';
import { Model, ModelStatic } from 'sequelize';

// Tables that may never be overwritten via backup import for security reasons.
const RESTRICTED_IMPORT_TABLES = ['users', 'api_credentials'];

export class BackupService {
    
    /**
     * Get all available table names
     */
    public getTables(): string[] {
        return Object.keys(sequelize.models);
    }

    /**
     * Get dependencies for a list of tables
     * Returns a set of all related tables (both parents and children)
     * based on Foreign Key relationships.
     */
    public getRelatedTables(selectedTables: string[]): string[] {
        const models = sequelize.models;
        const visited = new Set<string>();
        const queue = [...selectedTables];

        while (queue.length > 0) {
            const tableName = queue.shift();
            if (!tableName || visited.has(tableName)) continue;
            
            visited.add(tableName);
            const model = models[tableName];
            if (!model) continue;

            // Check associations
            for (const [associationName, association] of Object.entries(model.associations)) {
                const targetModel = association.target;
                const targetName = targetModel.name;
                
                if (!visited.has(targetName)) {
                    queue.push(targetName);
                }
            }
        }

        return Array.from(visited);
    }

    /**
     * Export data for selected tables into a ZIP buffer
     */
    public async exportData(tables: string[]): Promise<Buffer> {
        const relatedTables = this.getRelatedTables(tables);
        logger.info(`Exporting tables: ${relatedTables.join(', ')}`);

        const zip = new AdmZip();

        for (const tableName of relatedTables) {
            const model = sequelize.models[tableName];
            if (!model) continue;

            const data = await model.findAll();
            // Convert to plain objects
            const jsonData = data.map(d => d.get({ plain: true }));
            
            zip.addFile(`${tableName}.json`, Buffer.from(JSON.stringify(jsonData, null, 2)));
        }

        // Add metadata
        const metadata = {
            version: '1.0',
            timestamp: new Date().toISOString(),
            tables: relatedTables
        };
        zip.addFile('metadata.json', Buffer.from(JSON.stringify(metadata, null, 2)));

        return zip.toBuffer();
    }

    /**
     * Import data from ZIP buffer
     * Uses Topological Sort to insert in correct order
     */
    public async importData(zipBuffer: Buffer): Promise<void> {
        const zip = new AdmZip(zipBuffer);
        const zipEntries = zip.getEntries();
        
        const dataMap = new Map<string, any[]>();
        let metadata: any = null;

        // 1. Read files
        for (const entry of zipEntries) {
            if (entry.entryName === 'metadata.json') {
                metadata = JSON.parse(entry.getData().toString('utf8'));
                continue;
            }
            if (entry.entryName.endsWith('.json')) {
                const tableName = path.basename(entry.entryName, '.json');
                const data = JSON.parse(entry.getData().toString('utf8'));
                dataMap.set(tableName, data);
            }
        }

        if (!metadata) {
            throw new Error('Invalid backup file: Missing metadata.json');
        }

        const tablesToImport = Array.from(dataMap.keys());
        
        // Block import of sensitive tables that could be used for privilege escalation
        for (const tableName of tablesToImport) {
            if (RESTRICTED_IMPORT_TABLES.includes(tableName)) {
                throw new Error(`Import of table "${tableName}" is not allowed for security reasons`);
            }
        }
        
        // 2. Topological Sort
        const sortedTables = this.topologicalSort(tablesToImport);
        logger.info(`Import order: ${sortedTables.join(' -> ')}`);

        // 3. Transactional Insert
        const transaction = await sequelize.transaction();

        try {
            // Disable FK checks for SQLite if needed, but Topo Sort should handle it.
            // However, to be safe and handle circular deps (if any), we might need it.
            // But prompt asks for Topo Sort.
            
            // Clean existing data? 
            // Strategy: Delete all data from these tables in REVERSE Topo order, then Insert in Topo order.
            
            const reverseOrder = [...sortedTables].reverse();
            for (const tableName of reverseOrder) {
                const model = sequelize.models[tableName];
                if (model) {
                    // Truncate or Delete All
                    await model.destroy({ where: {}, transaction });
                }
            }

            // Insert
            for (const tableName of sortedTables) {
                const model = sequelize.models[tableName];
                const data = dataMap.get(tableName);
                
                if (model && data && data.length > 0) {
                    await model.bulkCreate(data, { 
                        transaction,
                        validate: true, // Ensure constraints
                        ignoreDuplicates: false // We cleared data, so duplicates shouldn't happen unless in input
                    });
                }
            }

            await transaction.commit();
            logger.info('Import completed successfully.');
        } catch (error) {
            await transaction.rollback();
            logger.error(`Import failed: ${error}`);
            throw error;
        }
    }

    /**
     * Sort tables based on dependencies (Parents first)
     */
    private topologicalSort(tables: string[]): string[] {
        const models = sequelize.models;
        const graph = new Map<string, Set<string>>();
        const inDegree = new Map<string, number>();

        // Initialize
        for (const table of tables) {
            graph.set(table, new Set());
            inDegree.set(table, 0);
        }

        // Build Graph
        for (const tableName of tables) {
            const model = models[tableName];
            if (!model) continue;

            for (const [_, association] of Object.entries(model.associations)) {
                // Check if this model BelongsTo another model (Dependency)
                // If A belongsTo B, B must come before A.
                // Edge: B -> A
                
                if (association.associationType === 'BelongsTo') {
                    const targetName = association.target.name;
                    if (tables.includes(targetName) && targetName !== tableName) {
                        if (!graph.get(targetName)!.has(tableName)) {
                            graph.get(targetName)!.add(tableName);
                            inDegree.set(tableName, (inDegree.get(tableName) || 0) + 1);
                        }
                    }
                }
                // Check HasOne / HasMany (Parent -> Child)
                // If A HasMany B, A is Parent. A comes before B.
                // Edge: A -> B
                else if (association.associationType === 'HasMany' || association.associationType === 'HasOne') {
                    const targetName = association.target.name;
                    if (tables.includes(targetName) && targetName !== tableName) {
                        if (!graph.get(tableName)!.has(targetName)) {
                            graph.get(tableName)!.add(targetName);
                            inDegree.set(targetName, (inDegree.get(targetName) || 0) + 1);
                        }
                    }
                }
            }
        }

        // Kahn's Algorithm
        const queue: string[] = [];
        const result: string[] = [];

        for (const [table, degree] of inDegree.entries()) {
            if (degree === 0) {
                queue.push(table);
            }
        }

        while (queue.length > 0) {
            const current = queue.shift()!;
            result.push(current);

            const neighbors = graph.get(current);
            if (neighbors) {
                for (const neighbor of neighbors) {
                    inDegree.set(neighbor, (inDegree.get(neighbor) || 0) - 1);
                    if (inDegree.get(neighbor) === 0) {
                        queue.push(neighbor);
                    }
                }
            }
        }

        // Check for cycles
        if (result.length !== tables.length) {
            const remaining = tables.filter(t => !result.includes(t));
            logger.warn(`Topological sort incomplete (possible cycle). Appending remaining: ${remaining.join(', ')}`);
            // Append remaining tables (best effort)
            return [...result, ...remaining];
        }

        return result;
    }
}

export default new BackupService();
