import Router from 'koa-router';
import ApiCredential from '../models/ApiCredential';
import {
  createApiCredentialToken,
  hashApiCredentialToken,
  normalizeScopes,
  READ_SCOPES,
  safeSerializeApiCredential,
  getApiCredentialTokenPrefix,
} from '../services/ApiCredentialService';
import { checkAdmin } from '../middleware/checkAdmin';

const router = new Router();

router.use(checkAdmin);

router.get('/', async (ctx) => {
  const credentials = await ApiCredential.findAll({ order: [['createdAt', 'DESC']] });
  ctx.body = credentials.map(safeSerializeApiCredential);
});

router.get('/scopes', async (ctx) => {
  ctx.body = { scopes: READ_SCOPES };
});

router.post('/', async (ctx) => {
  const { name, scopes, expiresAt } = ctx.request.body as any;
  const normalizedScopes = normalizeScopes(scopes);

  if (!name || typeof name !== 'string' || !name.trim()) {
    ctx.status = 400;
    ctx.body = { error: 'Name is required' };
    return;
  }

  if (normalizedScopes.length === 0) {
    ctx.status = 400;
    ctx.body = { error: 'At least one valid scope is required' };
    return;
  }

  const parsedExpiresAt = expiresAt ? new Date(expiresAt) : null;
  if (parsedExpiresAt && Number.isNaN(parsedExpiresAt.getTime())) {
    ctx.status = 400;
    ctx.body = { error: 'Invalid expiresAt' };
    return;
  }

  const credential = await ApiCredential.create({
    name: name.trim(),
    tokenPrefix: 'pending',
    tokenHash: 'pending',
    scopes: JSON.stringify(normalizedScopes),
    expiresAt: parsedExpiresAt,
    createdByUserId: ctx.state.user?.id ?? null,
  });

  const token = createApiCredentialToken(credential.id);
  credential.tokenPrefix = getApiCredentialTokenPrefix(token);
  credential.tokenHash = hashApiCredentialToken(token);
  await credential.save();

  ctx.status = 201;
  ctx.body = {
    credential: safeSerializeApiCredential(credential),
    token,
  };
});

router.post('/:id/disable', async (ctx) => {
  const credential = await ApiCredential.findByPk(ctx.params.id);
  if (!credential) {
    ctx.status = 404;
    ctx.body = { error: 'API credential not found' };
    return;
  }

  if (!credential.disabledAt) {
    credential.disabledAt = new Date();
    await credential.save();
  }

  ctx.body = safeSerializeApiCredential(credential);
});

router.delete('/:id', async (ctx) => {
  const credential = await ApiCredential.findByPk(ctx.params.id);
  if (!credential) {
    ctx.status = 404;
    ctx.body = { error: 'API credential not found' };
    return;
  }

  await credential.destroy();
  ctx.body = { success: true };
});

export default router;
