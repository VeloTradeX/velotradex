import { createRouter, createWebHashHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'

const routes = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('../views/Login.vue')
  },
  {
    path: '/',
    component: () => import('../views/Layout.vue'),
    meta: { requiresAuth: true },
    children: [
      {
        path: '',
        name: 'Dashboard',
        component: () => import('../views/Dashboard.vue')
      },
      {
        path: 'orders',
        name: 'Orders',
        component: () => import('../views/Orders.vue')
      },
      {
        path: 'virtual-exchange/orders',
        name: 'VirtualExchangeOrders',
        component: () => import('../views/VirtualExchangeOrders.vue')
      },
      {
        path: 'virtual-exchange/open-orders',
        name: 'VirtualExchangeOpenOrders',
        component: () => import('../views/VirtualExchangeOpenOrders.vue')
      },
      {
        path: 'virtual-exchange/trades',
        name: 'VirtualExchangeTrades',
        component: () => import('../views/VirtualExchangeTrades.vue')
      },
      {
        path: 'statistics',
        name: 'Statistics',
        component: () => import('../views/Statistics.vue')
      },
      // 历史回测功能暂时不可用，恢复时取消注释
      // {
      //   path: 'backtest',
      //   name: 'Backtest',
      //   component: () => import('../views/Backtest.vue')
      // },
      {
        path: 'positions',
        name: 'Positions',
        component: () => import('../views/Positions.vue')
      },
      {
        path: 'exchanges',
        name: 'Exchanges',
        component: () => import('../views/Exchanges.vue')
      },
      {
        path: 'routes',
        name: 'Routes',
        component: () => import('../views/Routes.vue')
      },
      {
        path: 'strategies',
        name: 'Strategies',
        component: () => import('../views/Strategies.vue')
      },
      {
        path: 'users',
        name: 'Users',
        component: () => import('../views/Users.vue')
      },
      {
        path: 'api-credentials',
        name: 'ApiCredentials',
        component: () => import('../views/ApiCredentials.vue')
      },
      {
        path: 'audit-logs',
        name: 'AuditLogs',
        component: () => import('../views/AuditLogs.vue')
      },
      {
        path: 'webhooks',
        name: 'Webhooks',
        component: () => import('../views/Webhooks.vue')
      },
      {
        path: 'ai-config',
        name: 'AIConfig',
        component: () => import('../views/AIConfig.vue')
      },
      {
        path: 'logs',
        name: 'Logs',
        component: () => import('../views/Logs.vue')
      },
      {
        path: 'backup',
        name: 'Backup',
        component: () => import('../views/Backup.vue')
      }
    ]
  }
]

const router = createRouter({
  history: createWebHashHistory(),
  routes
})

router.beforeEach((to, _from, next) => {
  const authStore = useAuthStore()
  if (to.meta.requiresAuth && !authStore.token) {
    // Save the original path to sessionStorage for redirect after login
    sessionStorage.setItem('loginRedirectPath', to.fullPath)
    next('/login')
  } else {
    next()
  }
})

export default router
