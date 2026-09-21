import Router from 'koa-router';
import { User, ApiCredential } from '../models';
import { checkAdmin } from '../middleware/checkAdmin';

const router = new Router();

router.use(checkAdmin);

router.get('/', async (ctx) => {
    const users = await User.findAll({
        attributes: ['id', 'username', 'role', 'createdAt']
    });
    ctx.body = users;
});

router.post('/', async (ctx) => {
    const { username, password, role } = ctx.request.body as any;
    
    if (!username || !password) {
        ctx.status = 400;
        ctx.body = { error: 'Username and password are required' };
        return;
    }

    try {
        const user = await User.create({
            username,
            password,
            role: role || 'viewer'
        });
        
        ctx.body = {
            id: user.id,
            username: user.username,
            role: user.role,
            createdAt: user.createdAt
        };
    } catch (err: any) {
        ctx.status = 500;
        ctx.body = { error: err.message };
    }
});

router.put('/:id', async (ctx) => {
    const { id } = ctx.params;
    const { password, role } = ctx.request.body as any;
    
    const user = await User.findByPk(id);
    if (!user) {
        ctx.status = 404;
        ctx.body = { error: 'User not found' };
        return;
    }

    if (password) user.password = password;
    if (role) user.role = role;
    
    await user.save();
    
    ctx.body = {
        id: user.id,
        username: user.username,
        role: user.role,
        createdAt: user.createdAt
    };
});

router.delete('/:id', async (ctx) => {
    const { id } = ctx.params;
    const currentUserId = (ctx.state.user as any)?.id;

    const user = await User.findByPk(id);
    if (!user) {
        ctx.status = 404;
        return;
    }

    // Prevent deleting self
    if (String(user.id) === String(currentUserId)) {
        ctx.status = 403;
        ctx.body = { error: 'Cannot delete your own account' };
        return;
    }

    // Prevent deleting the last admin
    if (user.role === 'admin') {
        const adminCount = await User.count({ where: { role: 'admin' } });
        if (adminCount <= 1) {
            ctx.status = 403;
            ctx.body = { error: 'Cannot delete the last admin user' };
            return;
        }
    }

    // 依赖检查：该用户创建了 API 凭据时禁止删除，避免凭据丢失属主
    const createdCredentials = await ApiCredential.count({ where: { createdByUserId: id } });
    if (createdCredentials > 0) {
        ctx.status = 409;
        ctx.body = { error: `该用户创建了 ${createdCredentials} 个 API 凭据，请先删除这些凭据再删除用户` };
        return;
    }

    await user.destroy();
    ctx.body = { success: true };
});

export default router;
