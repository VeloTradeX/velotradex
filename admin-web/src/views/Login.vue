<template>
  <div class="login-container">
    <el-card class="login-card">
      <div class="login-logo-container">
        <!-- Logo Image Placeholder -->
        <div class="login-logo-placeholder">
           <div class="logo-box-lg">
            <img src="../assets/velotradex-logo.png" alt="VeloTradeX Logo" />
           </div>
        </div>
      </div>
      <div class="login-title">
        <h1>VeloTradeX</h1>
        <p class="subtitle">自动化跟单管理系统</p>
      </div>
      
      <el-form :model="form" label-position="top" size="large">
        <el-form-item label="用户名">
          <el-input v-model="form.username" placeholder="请输入用户名" />
        </el-form-item>
        <el-form-item label="密码">
          <el-input v-model="form.password" type="password" placeholder="请输入密码" show-password @keyup.enter="onSubmit" />
        </el-form-item>
        <el-form-item>
          <el-button type="primary" class="login-button" @click="onSubmit" :loading="loading">
            登录控制台
          </el-button>
        </el-form-item>
      </el-form>
    </el-card>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref } from 'vue'
import { useAuthStore } from '../stores/auth'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'

const form = reactive({
  username: '',
  password: ''
})
const loading = ref(false)
const authStore = useAuthStore()
const router = useRouter()

const onSubmit = async () => {
  loading.value = true
  const success = await authStore.login(form.username, form.password)
  loading.value = false
  if (success) {
    ElMessage.success('登录成功')
    // Get redirect path from sessionStorage
    const redirectPath = sessionStorage.getItem('loginRedirectPath')
    if (redirectPath) {
      sessionStorage.removeItem('loginRedirectPath')
      router.push(redirectPath)
    } else {
      router.push('/')
    }
  } else {
    ElMessage.error('登录失败，请检查用户名或密码')
  }
}
</script>

<style scoped>
.login-container {
  display: flex;
  justify-content: center;
  align-items: center;
  height: 100vh;
  background-color: var(--bg-color-base);
  background-image: radial-gradient(circle at 50% 50%, rgba(255, 184, 0, 0.05) 0%, transparent 50%);
}

.login-card {
  width: 420px;
  padding: 40px;
  background-color: var(--bg-color-card);
  border: 1px solid var(--border-color-base);
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  border-radius: 24px;
}

.login-logo-container {
  display: flex;
  justify-content: center;
  margin-bottom: 24px;
}

.login-logo-placeholder {
  width: 80px;
  height: 80px;
}

.logo-box-lg {
  width: 100%;
  height: 100%;
  background: linear-gradient(135deg, var(--color-primary-start), var(--color-primary-end));
  border-radius: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  font-weight: bold;
  color: #000;
}

.login-logo-placeholder img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}



.login-title {
  text-align: center;
  margin-bottom: 40px;
}

.login-title h1 {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: var(--text-color-primary);
}

.subtitle {
  margin: 0;
  color: var(--text-color-secondary);
  font-size: 14px;
}

.login-button {
  width: 100%;
  height: 48px;
  font-size: 16px;
  margin-top: 10px;
  border-radius: 12px;
}

/* Form Styles Override */
:deep(.el-form-item__label) {
  color: var(--text-color-secondary) !important;
}

:deep(.el-input__wrapper) {
  background-color: rgba(255, 255, 255, 0.03) !important;
  border-radius: 12px;
  padding: 8px 15px;
}
</style>
