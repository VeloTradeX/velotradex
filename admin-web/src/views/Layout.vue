<template>
  <el-container class="layout-container">
    <el-aside :width="isCollapsed ? '64px' : '240px'" class="sidebar-aside">
      <div class="sidebar-header" :class="{ 'sidebar-header--collapsed': isCollapsed }">
        <div class="logo-placeholder">
          <div class="logo-box">
            <img src="../assets/velotradex-logo.png" alt="VeloTradeX Logo" />
          </div>
        </div>
        <transition name="fade">
          <h1 v-show="!isCollapsed" class="app-title">VeloTradeX</h1>
        </transition>
      </div>
      
      <el-scrollbar class="sidebar-scroll">
      <el-menu
        router
        :default-active="$route.path"
        :collapse="isCollapsed"
        :collapse-transition="false"
        class="el-menu-vertical"
        background-color="#131416"
        text-color="#8E8E93"
        active-text-color="#FFB800"
      >
        <el-menu-item index="/">
          <el-icon><IconDashboard /></el-icon>
          <template #title>仪表盘</template>
        </el-menu-item>
        <el-menu-item index="/strategies">
          <el-icon><IconChartLine /></el-icon>
          <template #title>策略信号</template>
        </el-menu-item>
        <el-menu-item index="/orders">
          <el-icon><IconClipboardList /></el-icon>
          <template #title>订单管理</template>
        </el-menu-item>
        <el-sub-menu index="virtual-exchange">
          <template #title>
            <el-icon><IconChartCandle /></el-icon>
            <span>虚拟交易所</span>
          </template>
          <el-menu-item index="/virtual-exchange/orders">
            <el-icon><IconClipboardList /></el-icon>
            <template #title>订单</template>
          </el-menu-item>
          <el-menu-item index="/virtual-exchange/open-orders">
            <el-icon><IconClipboardList /></el-icon>
            <template #title>挂单</template>
          </el-menu-item>
          <el-menu-item index="/virtual-exchange/trades">
            <el-icon><IconFileText /></el-icon>
            <template #title>记录单</template>
          </el-menu-item>
        </el-sub-menu>
        <el-menu-item index="/positions">
          <el-icon><IconWallet /></el-icon>
          <template #title>交易管理</template>
        </el-menu-item>
        <el-menu-item index="/statistics">
          <el-icon><IconChartBar /></el-icon>
          <template #title>统计分析</template>
        </el-menu-item>
        <!-- 历史回测功能暂时不可用，恢复时取消注释
        <el-menu-item index="/backtest">
          <el-icon><IconHistory /></el-icon>
          <template #title>历史回测</template>
        </el-menu-item>
        -->
        <el-menu-item index="/ai-config">
            <el-icon><IconSparkles /></el-icon>
            <template #title>AI 解析</template>
        </el-menu-item>
        <el-menu-item index="/exchanges">
          <el-icon><IconPlugConnected /></el-icon>
          <template #title>交易所管理</template>
        </el-menu-item>
        <el-menu-item index="/routes">
          <el-icon><IconRoute /></el-icon>
          <template #title>信号路由</template>
        </el-menu-item>

        <el-sub-menu index="system">
            <template #title>
                <el-icon><IconSettings /></el-icon>
                <span>系统管理</span>
            </template>
            <el-menu-item index="/users" v-if="authStore.user?.role === 'admin'">
                <el-icon><IconUsers /></el-icon>
                <template #title>用户管理</template>
            </el-menu-item>
            <el-menu-item index="/api-credentials" v-if="authStore.user?.role === 'admin'">
                <el-icon><IconKey /></el-icon>
                <template #title>API 凭证</template>
            </el-menu-item>
            <el-menu-item index="/audit-logs">
                <el-icon><IconShieldCheck /></el-icon>
                <template #title>操作审计</template>
            </el-menu-item>
            <el-menu-item index="/webhooks">
                <el-icon><IconBell /></el-icon>
                <template #title>Webhook 通知</template>
            </el-menu-item>
            <el-menu-item index="/logs">
                <el-icon><IconFileText /></el-icon>
                <template #title>系统日志</template>
            </el-menu-item>
            <el-menu-item index="/backup" v-if="authStore.user?.role === 'admin'">
                <el-icon><IconRefresh /></el-icon>
                <template #title>备份恢复</template>
            </el-menu-item>
        </el-sub-menu>
      </el-menu>
      </el-scrollbar>
      <div class="sidebar-toggle" @click="toggleSidebar">
        <el-icon :size="18">
          <Fold v-if="!isCollapsed" />
          <Expand v-else />
        </el-icon>
        <span v-show="!isCollapsed" class="sidebar-toggle-text">收起</span>
      </div>
    </el-aside>
    
    <el-container>
      <el-header>
        <div class="header-content">
          <span v-if="showPageTitle" class="page-title">{{ currentRouteName }}</span>
          <div class="user-info">
             <el-dropdown @command="handleCommand">
                <span class="el-dropdown-link" style="color: var(--text-color-primary); cursor: pointer; display: flex; align-items: center;">
                    {{ authStore.user?.username }}
                    <el-icon class="el-icon--right"><ArrowDown /></el-icon>
                </span>
                <template #dropdown>
                    <el-dropdown-menu>
                        <el-dropdown-item command="password">修改密码</el-dropdown-item>
                        <el-dropdown-item command="logout">退出登录</el-dropdown-item>
                    </el-dropdown-menu>
                </template>
            </el-dropdown>
          </div>
        </div>
      </el-header>
      
      <el-main>
        <router-view />
      </el-main>
    </el-container>

    <!-- Change Password Dialog -->
    <el-dialog v-model="passwordDialogVisible" title="修改密码" width="400px">
        <el-form :model="passwordForm" label-width="120px" :rules="passwordRules" ref="passwordFormRef">
            <el-form-item label="原密码" prop="oldPassword">
                <el-input type="password" v-model="passwordForm.oldPassword" show-password />
            </el-form-item>
            <el-form-item label="新密码" prop="newPassword">
                <el-input type="password" v-model="passwordForm.newPassword" show-password />
            </el-form-item>
            <el-form-item label="确认新密码" prop="confirmPassword">
                <el-input type="password" v-model="passwordForm.confirmPassword" show-password />
            </el-form-item>
        </el-form>
        <template #footer>
            <span class="dialog-footer">
                <el-button @click="passwordDialogVisible = false">取消</el-button>
                <el-button type="primary" @click="submitPasswordChange" :loading="passwordSubmitting">确定</el-button>
            </span>
        </template>
    </el-dialog>
  </el-container>
</template>

<script setup lang="ts">
import { ref, reactive, computed, watch } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useRoute } from 'vue-router'
import { ArrowDown, Fold, Expand } from '@element-plus/icons-vue'
import {
  IconDashboard,
  IconChartLine,
  IconClipboardList,
  IconChartCandle,
  IconChartBar,
  IconWallet,
  IconPlugConnected,
  IconRoute,
  IconSparkles,
  IconSettings,
  IconUsers,
  IconShieldCheck,
  IconBell,
  IconFileText,
  IconRefresh,
  IconKey,
  // IconHistory // 历史回测功能暂时不可用
} from '@tabler/icons-vue'
import request from '../utils/request'
import { ElMessage } from 'element-plus'

const authStore = useAuthStore()
const route = useRoute()
const passwordDialogVisible = ref(false)
const passwordSubmitting = ref(false)
const passwordFormRef = ref(null)

const isCollapsed = ref(localStorage.getItem('sidebarCollapsed') === 'true')

watch(isCollapsed, (val) => {
  localStorage.setItem('sidebarCollapsed', String(val))
})

const toggleSidebar = () => {
  isCollapsed.value = !isCollapsed.value
}

const currentRouteName = computed(() => {
  const routeMap: Record<string, string> = {
    '/': '仪表盘',
    '/strategies': '策略信号',
    '/orders': '订单管理',
    '/virtual-exchange/orders': '虚拟交易所 / 订单',
    '/virtual-exchange/open-orders': '虚拟交易所 / 挂单',
    '/virtual-exchange/trades': '虚拟交易所 / 记录单',
    '/statistics': '统计分析',
    '/positions': '交易管理',
    '/exchanges': '交易所管理',
    '/routes': '信号路由',
    '/users': '用户管理',
    '/api-credentials': 'API 凭证',
    '/audit-logs': '操作审计',
    '/webhooks': 'Webhook 通知',
    '/ai-config': 'AI 解析',
    '/logs': '系统日志',
    '/backup': '备份恢复'
  }
  return routeMap[route.path] || 'VeloTradeX Admin'
})

const showPageTitle = computed(() => {
  return !['/webhooks'].includes(route.path)
})

const passwordForm = reactive({
    oldPassword: '',
    newPassword: '',
    confirmPassword: ''
})

const validatePass2 = (_rule: any, value: any, callback: any) => {
    if (value === '') {
        callback(new Error('请再次输入密码'))
    } else if (value !== passwordForm.newPassword) {
        callback(new Error('两次输入密码不一致!'))
    } else {
        callback()
    }
}

const passwordRules = {
    oldPassword: [{ required: true, message: '请输入原密码', trigger: 'blur' }],
    newPassword: [{ required: true, message: '请输入新密码', trigger: 'blur' }],
    confirmPassword: [{ validator: validatePass2, trigger: 'blur' }]
}

const handleCommand = (command: string) => {
    if (command === 'logout') {
        logout()
    } else if (command === 'password') {
        openPasswordDialog()
    }
}

const openPasswordDialog = () => {
    passwordForm.oldPassword = ''
    passwordForm.newPassword = ''
    passwordForm.confirmPassword = ''
    passwordDialogVisible.value = true
}

const submitPasswordChange = async () => {
    if (!passwordFormRef.value) return
    await (passwordFormRef.value as any).validate(async (valid: boolean) => {
        if (valid) {
            passwordSubmitting.value = true
            try {
                await request.post('/auth/change-password', {
                    oldPassword: passwordForm.oldPassword,
                    newPassword: passwordForm.newPassword
                })
                ElMessage.success('密码修改成功')
                passwordDialogVisible.value = false
            } catch (e: any) {
                ElMessage.error(e.response?.data?.error || '修改失败')
            } finally {
                passwordSubmitting.value = false
            }
        }
    })
}

const logout = () => {
  authStore.logout()
}
</script>

<style scoped>
.el-scrollbar {
  background-color: #131416;
}
.layout-container {
  height: 100vh;
}
.el-menu-vertical {
  height: auto;
  min-height: 100%;
  border-right: none;
}
.sidebar-scroll {
  height: calc(100vh - 60px - 48px);
}
.el-header {
  background-color: #131416;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  color: #ffffff;
  padding: 0;
  --text-color-primary: #ffffff;
}
.header-content {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 24px;
  height: 100%;
}
.page-title {
  font-size: 18px;
  font-weight: 600;
  color: #ffffff;
}
.user-info {
  display: flex;
  align-items: center;
}

/* Sidebar */
.sidebar-aside {
  transition: width 0.3s ease;
  overflow: hidden;
}
.sidebar-header {
  height: 60px;
  display: flex;
  align-items: center;
  padding: 0 20px;
  background-color: #131416;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  transition: padding 0.3s ease;
}
.sidebar-header--collapsed {
  justify-content: center;
  padding: 0;
}
.logo-placeholder {
  width: 32px;
  height: 32px;
  margin-right: 12px;
  flex-shrink: 0;
}
.sidebar-header--collapsed .logo-placeholder {
  margin-right: 0;
}
.logo-box {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--color-primary-start), var(--color-primary-end));
  border-radius: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: bold;
  color: #000;
}
.logo-box img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.app-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
  white-space: nowrap;
}

/* Toggle button */
.sidebar-toggle {
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.05);
  background-color: #131416;
  color: #8E8E93;
  cursor: pointer;
  transition: color 0.2s;
  flex-shrink: 0;
}
.sidebar-toggle:hover {
  color: #FFB800;
}
.sidebar-toggle-text {
  font-size: 13px;
  white-space: nowrap;
}

/* Fade transition for title */
.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.2s ease;
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

/* Collapsed menu adjustments */
:deep(.el-menu--collapse .el-sub-menu__title span),
:deep(.el-menu--collapse .el-menu-item span) {
  display: none;
}
</style>
