import Router from 'koa-router';
import strategyParserRegistry from '../services/parsers';
import SignalRoute from '../models/SignalRoute';

const router = new Router();

router.get('/', async (ctx) => {
    const parsers = strategyParserRegistry.getAllParsers();
    const parserList = await Promise.all(parsers.map(async (p) => {
        const parserInstance = strategyParserRegistry.getParserByName(p.name);
        const routes = await SignalRoute.findAll({ where: { parser: p.name } });
        // Return first channel ID found, or null.
        // We return channelId for backward compatibility with tools expecting a channel context.
        const channelId = routes.length > 0 ? routes[0].channelId : null;
        return {
            ...p,
            channelId,
            riskConfig: parserInstance?.getRiskConfig() ?? null,
        };
    }));
    ctx.body = parserList;
});

export default router;
