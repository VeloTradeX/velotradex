import Router from 'koa-router';
import logService from '../services/LogService';
import logger, { formatError } from '../utils/logger';

const router = new Router();

router.get('/', async (ctx) => {
    try {
        const page = parseInt(ctx.query.page as string) || 1;
        const pageSize = parseInt(ctx.query.pageSize as string) || 20;
        const traceId = ctx.query.traceId as string;
        const keyword = ctx.query.keyword as string;
        const level = ctx.query.level as string;
        const sort = (ctx.query.sort as 'asc' | 'desc') || 'desc';
        const requestedSource = ctx.query.source as string;
        const source = requestedSource === 'error' ? 'error' : 'normal';
        const startDate = ctx.query.startDate as string;
        const endDate = ctx.query.endDate as string;

        const result = await logService.getLogs({
            page,
            pageSize,
            traceId,
            keyword,
            level,
            sort,
            source,
            startDate,
            endDate
        });

        ctx.body = {
            success: true,
            data: result.logs,
            total: result.total,
            page,
            pageSize
        };
    } catch (error: any) {
        logger.error('Failed to fetch logs', formatError(error));
        ctx.status = 500;
        ctx.body = {
            success: false,
            error: 'Failed to fetch logs'
        };
    }
});

export default router;
