import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import util from 'util';
import { shellEscapeDoubleQuoted, isSafeFilterValue } from '../utils/shellEscape';

const execPromise = util.promisify(exec);

interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  traceId?: string;
  [key: string]: any;
}

interface LogQueryOptions {
  page?: number;
  pageSize?: number;
  traceId?: string;
  keyword?: string;
  level?: string;
  sort?: 'asc' | 'desc';
  source?: 'normal' | 'error';
  startDate?: string;
  endDate?: string;
}

class LogService {
  private logDir: string;

  constructor() {
    this.logDir = path.join(process.cwd(), 'logs');
  }

  private getLogFile(source?: LogQueryOptions['source']): string {
    const prefix = source === 'error' ? 'error-' : 'combined-';
    // Find the most recent log file matching the DailyRotateFile pattern (e.g. combined-2026-07-20.log)
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith(prefix) && f.endsWith('.log'))
        .sort()
        .reverse();
      if (files.length > 0) {
        return path.join(this.logDir, files[0]);
      }
    } catch {
      // Directory may not exist yet
    }
    // Fallback to legacy filename for backward compat
    const fileName = source === 'error' ? 'error.log' : 'combined.log';
    return path.join(this.logDir, fileName);
  }

  private parseDate(value?: string): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private isWithinRange(entry: LogEntry, startDate: Date | null, endDate: Date | null): boolean {
    if (!startDate && !endDate) return true;
    if (!entry.timestamp) return false;
    const entryDate = new Date(entry.timestamp);
    if (Number.isNaN(entryDate.getTime())) return false;
    if (startDate && entryDate < startDate) return false;
    if (endDate && entryDate > endDate) return false;
    return true;
  }

  async getLogs(options: LogQueryOptions): Promise<{ logs: LogEntry[], total: number }> {
    const page = options.page || 1;
    const pageSize = options.pageSize || 20;
    const sort = options.sort || 'desc';
    const startDate = this.parseDate(options.startDate);
    const endDate = this.parseDate(options.endDate);
    const logFile = this.getLogFile(options.source);
    
    // Construct grep command for filtering
    let grepCmd = '';
    if (options.traceId) {
      const safeTraceId = shellEscapeDoubleQuoted(options.traceId);
      grepCmd += ` | grep "${safeTraceId}"`;
    }
    if (options.keyword) {
      const safeKeyword = shellEscapeDoubleQuoted(options.keyword);
      grepCmd += ` | grep -i "${safeKeyword}"`;
    }
    if (options.level) {
      if (!isSafeFilterValue(options.level)) {
        throw new Error(`Invalid log level filter: ${options.level}`);
      }
      grepCmd += ` | grep '"level":"${options.level}"'`;
    }

    // Command to get total count matching filter
    // If no filter, use wc -l directly on file
    // If filter, use cat file | grep ... | wc -l
    let countCmd = '';
    if (grepCmd) {
      countCmd = `cat "${logFile}" ${grepCmd} | wc -l`;
    } else {
      countCmd = `wc -l < "${logFile}"`;
    }

    // Command to get logs
    // DESC (Newest first): tail -n (page * pageSize) | head -n pageSize
    // ASC (Oldest first): head -n (page * pageSize) | tail -n pageSize
    const numLines = page * pageSize;
    let logsCmd = '';
    
    const baseCmd = grepCmd ? `cat "${logFile}" ${grepCmd}` : `cat "${logFile}"`;

    if (sort === 'desc') {
        // Get last N lines, then take first M of those
        logsCmd = `${baseCmd} | tail -n ${numLines} | head -n ${pageSize}`;
    } else {
        // Get first N lines, then take last M of those
        logsCmd = `${baseCmd} | head -n ${numLines} | tail -n ${pageSize}`;
    }

    try {
      const [countResult, logsResult] = await Promise.all([
        execPromise(countCmd, { maxBuffer: 1024 * 1024 * 10 }), // 10MB buffer
        execPromise(logsCmd, { maxBuffer: 1024 * 1024 * 10 })
      ]);

      const total = parseInt(countResult.stdout.trim(), 10) || 0;
      const lines = logsResult.stdout.trim().split('\n');
      
      const logs: LogEntry[] = [];
      
      // Process lines
      // If DESC, the command returns oldest -> newest within the window (tail logic)
      // So we reverse it to show newest at top
      // If ASC, the command returns oldest -> newest within the window (head logic)
      // So we keep it as is
      
      const processLine = (line: string): LogEntry | null => {
        if (!line) return null;
        try {
          return JSON.parse(line);
        } catch (e) {
          return {
            timestamp: new Date().toISOString(),
            level: 'unknown',
            message: line,
            raw: true
          };
        }
      };

      if (sort === 'desc') {
          for (let i = lines.length - 1; i >= 0; i--) {
            const entry = processLine(lines[i]);
            if (entry && this.isWithinRange(entry, startDate, endDate)) logs.push(entry);
          }
      } else {
          for (let i = 0; i < lines.length; i++) {
            const entry = processLine(lines[i]);
            if (entry && this.isWithinRange(entry, startDate, endDate)) logs.push(entry);
          }
      }

      return { logs, total };
    } catch (error) {
      console.error('Failed to query logs:', error);
      return { logs: [], total: 0 };
    }
  }
}

export default new LogService();
