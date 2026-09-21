import { SignalRoute } from '../models';
import logger from '../utils/logger';
import { createStageDebug } from '../utils/debug';

const debugRouting = createStageDebug('routing');

class RoutingService {
    private routes: Map<string, SignalRoute[]> = new Map();

    public async initialize() {
        try {
            const routes = await SignalRoute.findAll({ where: { isActive: true } });
            for (const route of routes) {
                this.addRoute(route);
            }
            logger.info(`RoutingService initialized with ${routes.length} routes.`);
            debugRouting('initialized active routes %o', {
                routeCount: routes.length,
                channels: Array.from(this.routes.keys()),
            });
        } catch (error) {
            logger.error('Failed to initialize RoutingService', { error });
            debugRouting('initialization failed %o', { error });
        }
    }

    private addRoute(route: SignalRoute) {
        if (!this.routes.has(route.channelId)) {
            this.routes.set(route.channelId, []);
        }
        this.routes.get(route.channelId)!.push(route);
    }

    public getRoutes(channelId: string): SignalRoute[] {
        const routes = this.routes.get(channelId) || [];
        debugRouting('matched routes for channel %o', {
            channelId,
            routeCount: routes.length,
            routes: routes.map((route) => ({
                id: route.id,
                name: route.name,
                parser: route.parser || 'DefaultParser',
                exchangeInstanceId: route.exchangeInstanceId,
                aiMode: (route as any).aiMode || 'disabled',
            })),
        });
        return routes;
    }

    public async reloadRoutes() {
        this.routes.clear();
        await this.initialize();
    }
}

export default new RoutingService();
