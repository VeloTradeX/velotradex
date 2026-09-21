import Router from 'koa-router';
import multer from '@koa/multer';
import backupService from '../services/BackupService';
import { checkAdmin } from '../middleware/checkAdmin';

const router = new Router();
const upload = multer({ limits: { fileSize: 20 * 1024 * 1024 } });

router.use(checkAdmin);

router.get('/tables', async (ctx) => {
    ctx.body = backupService.getTables();
});

router.post('/related', async (ctx) => {
    const { tables } = ctx.request.body as any;
    ctx.body = { related: backupService.getRelatedTables(tables) };
});

router.post('/export', async (ctx) => {
    const { tables } = ctx.request.body as any;
    if (!tables || !Array.isArray(tables)) {
        ctx.throw(400, 'tables array is required');
        return;
    }
    
    const buffer = await backupService.exportData(tables);
    ctx.set('Content-Type', 'application/zip');
    ctx.set('Content-Disposition', `attachment; filename=backup-${Date.now()}.zip`);
    ctx.body = buffer;
});

router.post('/import', async (ctx) => {
    try {
        await upload.single('file')(ctx as any, async () => {});
    } catch (error: any) {
        if (error && error.code === 'LIMIT_FILE_SIZE') {
            ctx.status = 413;
            ctx.body = { error: 'File too large, maximum allowed size is 20MB' };
            return;
        }
        throw error;
    }

    const file = (ctx as any).file;
    if (!file) {
        ctx.throw(400, 'No file uploaded');
        return;
    }
    await backupService.importData(file.buffer);
    ctx.body = { success: true };
});

export default router;
