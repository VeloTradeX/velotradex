import Router from 'koa-router';
import { ApiAuditLog } from '../models';
import { Op } from 'sequelize';

function escapeLikePattern(str: string): string {
    return str.replace(/[%_\\]/g, '\\$&');
}

const router = new Router();

router.get('/', async (ctx) => {
    const { page = 1, limit = 20, userId, method, path, startDate, endDate } = ctx.query;
    
    const where: any = {};
    if (userId) where.userId = userId;
    if (method) where.method = method;
    if (path) where.path = { [Op.like]: `%${escapeLikePattern(path as string)}%` };
    if (startDate && endDate) {
        where.createdAt = {
            [Op.between]: [new Date(startDate as string), new Date(endDate as string)]
        };
    }

    const offset = (Number(page) - 1) * Number(limit);

    const { count, rows } = await ApiAuditLog.findAndCountAll({
        where,
        limit: Number(limit),
        offset,
        order: [['createdAt', 'DESC']]
    });

    ctx.body = {
        data: rows,
        total: count,
        page: Number(page),
        limit: Number(limit)
    };
});

export default router;
