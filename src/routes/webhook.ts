import Router from 'koa-router';
import { WebhookConfig } from '../models';
import webhookService from '../services/WebhookService';
import { validateWebhookUrl, sanitizeCustomHeaders } from '../utils/ssrfProtection';

const router = new Router();

const sensitiveWebhookFields = [
    'password',
    'apisecret',
    'apikey',
    'token',
    'secret',
    'userkey',
    'authorization',
];

// Recursively redact sensitive keys in place within webhook headers/config objects.
function redactWebhookSensitive(obj: any): void {
    if (!obj || typeof obj !== 'object') {
        return;
    }
    for (const key of Object.keys(obj)) {
        const value = obj[key];
        if (sensitiveWebhookFields.some((field) => key.toLowerCase().includes(field))) {
            obj[key] = '******';
        } else if (value && typeof value === 'object') {
            redactWebhookSensitive(value);
        }
    }
}

// GET /api/webhooks
router.get('/', async (ctx) => {
    const configs = await WebhookConfig.findAll({ order: [['createdAt', 'DESC']] });
    for (const config of configs) {
        redactWebhookSensitive(config.headers);
        redactWebhookSensitive(config.config);
    }
    ctx.body = configs;
});

// GET /api/webhooks/:id
router.get('/:id', async (ctx) => {
    const { id } = ctx.params;
    const config = await WebhookConfig.findByPk(id);
    if (!config) {
        ctx.status = 404;
        ctx.body = { error: 'Webhook config not found' };
        return;
    }
    redactWebhookSensitive(config.headers);
    redactWebhookSensitive(config.config);
    ctx.body = config;
});

// POST /api/webhooks
router.post('/', async (ctx) => {
    const { name, type, url, method, headers, template, config: extraConfig, events, isActive } = ctx.request.body as any;
    
    if (!name) {
        ctx.status = 400;
        ctx.body = { error: 'Name is required' };
        return;
    }

    // URL is optional for Pushover if using default
    const isPushover = type === 'pushover';
    if (!isPushover && !url) {
         ctx.status = 400;
         ctx.body = { error: 'URL is required' };
         return;
    }

    try {
        const config = await WebhookConfig.create({
            name,
            type: type || 'webhook',
            url: url || '',
            method: method || 'POST',
            headers: headers || '{}',
            template: template || '',
            config: extraConfig || '{}',
            events: events || [],
            isActive: isActive !== undefined ? isActive : true
        });
        
        // Reload service configs
        await webhookService.reloadConfigs();
        
        ctx.body = config;
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

// PUT /api/webhooks/:id
router.put('/:id', async (ctx) => {
    const { id } = ctx.params;
    const { name, type, url, method, headers, template, config: extraConfig, events, isActive } = ctx.request.body as any;
    
    const config = await WebhookConfig.findByPk(id);
    if (!config) {
        ctx.status = 404;
        ctx.body = { error: 'Webhook config not found' };
        return;
    }

    try {
        if (name !== undefined) config.name = name;
        if (type !== undefined) config.type = type;
        if (url !== undefined) config.url = url;
        if (method !== undefined) config.method = method;
        if (headers !== undefined) config.headers = headers;
        if (template !== undefined) config.template = template;
        if (extraConfig !== undefined) config.config = extraConfig;
        if (events !== undefined) config.events = events; // Setter handles string/array
        if (isActive !== undefined) config.isActive = isActive;
        
        await config.save();
        
        // Reload service configs
        await webhookService.reloadConfigs();
        
        ctx.body = config;
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

// DELETE /api/webhooks/:id
router.delete('/:id', async (ctx) => {
    const { id } = ctx.params;
    const config = await WebhookConfig.findByPk(id);
    
    if (!config) {
        ctx.status = 404;
        ctx.body = { error: 'Webhook config not found' };
        return;
    }

    await config.destroy();
    
    // Reload service configs
    await webhookService.reloadConfigs();
    
    ctx.body = { success: true };
});

// POST /api/webhooks/:id/test
router.post('/:id/test', async (ctx) => {
    const { id } = ctx.params;
    const config = await WebhookConfig.findByPk(id);
    
    if (!config) {
        ctx.status = 404;
        ctx.body = { error: 'Webhook config not found' };
        return;
    }

    try {
        // Use WebhookService.dispatch directly but force this specific config?
        // WebhookService.dispatch iterates all configs.
        // We want to test THIS specific config instance.
        // We can reuse the send logic from WebhookService if we export it or expose a test method.
        // Or we just instantiate the logic here again or import the private methods? No private.
        // Let's implement a test dispatch in WebhookService or just duplicate logic here but updated for types.
        
        // Duplicating logic here is easier for now to avoid refactoring Service to public.
        // But logic is getting complex (Feishu, Dingtalk, Pushover).
        // Let's call webhookService.dispatch with a fake event but filter only this config? No.
        
        // Better: Expose a `testConfig(config)` method in WebhookService.
        // But for now, let's just inline the logic as we did before, but updated.
        
        const axios = require('axios');
        const timestamp = Date.now();
        const event = 'WEBHOOK_TEST';
        const payload = {
            event,
            timestamp,
            data: {
                message: 'This is a test webhook from VeloTradeX',
                user: ctx.state.user?.username
            }
        };

        const type = config.type || 'webhook';

        if (type === 'webhook') {
            const customHeaders = typeof config.headers === 'string' ? JSON.parse(config.headers) : config.headers;
            const headers: any = {
              'Content-Type': 'application/json',
              'X-Webhook-Event': event,
              'X-Webhook-Timestamp': timestamp.toString(),
              ...customHeaders
            };
            validateWebhookUrl(config.url);
            const safeHeaders = sanitizeCustomHeaders(headers);
            await axios({
                method: config.method || 'POST',
                url: config.url,
                data: payload,
                headers: safeHeaders,
                timeout: 5000
            });
        } else if (type === 'feishu') {
             const text = `[CopyTrader] Test\nTime: ${new Date().toLocaleString()}\n\nTest Message`;
             await axios.post(config.url, {
                  msg_type: 'text',
                  content: { text: text }
             }, { timeout: 5000 });
        } else if (type === 'dingtalk') {
             const text = `[CopyTrader] Test\nTime: ${new Date().toLocaleString()}\n\nTest Message`;
             await axios.post(config.url, {
                  msgtype: 'text',
                  text: { content: text }
             }, { timeout: 5000 });
        } else if (type === 'pushover') {
             const extraConfig = typeof config.config === 'string' ? JSON.parse(config.config) : config.config;
             const userKey = extraConfig.userKey; 
             const token = extraConfig.token;
             const url = config.url || 'https://api.pushover.net/1/messages.json';
             
             if (!userKey || !token) throw new Error('Pushover requires userKey and token');

             await axios.post(url, {
                  token: token,
                  user: userKey,
                  message: 'Test Message from VeloTradeX',
                  title: 'CopyTrader Test',
                  timestamp: Math.floor(Date.now() / 1000)
             }, { timeout: 5000 });
        }
        
        ctx.body = { success: true, message: 'Test webhook sent successfully' };
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: `Test failed: ${err.message}` };
    }
});

export default router;
