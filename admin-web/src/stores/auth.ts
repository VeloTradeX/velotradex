import { defineStore } from 'pinia'
import request from '../utils/request'
import { ref } from 'vue'
import { useRouter } from 'vue-router'

export const useAuthStore = defineStore('auth', () => {
  const token = ref<string>('')
  const refreshToken = ref<string>('')
  const user = ref<any>(null)

  // Initialize from localStorage with strict validation
  function initFromStorage() {
    const t = localStorage.getItem('token')
    const rt = localStorage.getItem('refreshToken')
    const u = localStorage.getItem('user')
    token.value = (typeof t === 'string' && t.length > 10) ? t : ''
    refreshToken.value = (typeof rt === 'string' && rt.length > 10) ? rt : ''
    try {
      user.value = u ? JSON.parse(u) : null
    } catch (e) {
      user.value = null
      localStorage.removeItem('user')
    }
  }

  initFromStorage()

  async function login(username: string, password: string) {
    try {
      const res = await request.post('/auth/login', { username, password })
      const data = res.data || {}

      // Strictly validate tokens before accepting the login
      const newToken: string | undefined = data.token
      const newRefreshToken: string | undefined = data.refreshToken

      if (!newToken || typeof newToken !== 'string' || newToken.length < 10) {
        console.error('[auth] Login response missing/invalid token field:', data)
        return false
      }
      if (!newRefreshToken || typeof newRefreshToken !== 'string' || newRefreshToken.length < 10) {
        console.error('[auth] Login response missing/invalid refreshToken field:', data)
        localStorage.removeItem('refreshToken')
      }

      token.value = newToken
      refreshToken.value = (newRefreshToken && newRefreshToken.length >= 10) ? newRefreshToken : ''
      user.value = data.user || null

      localStorage.setItem('token', token.value)
      if (refreshToken.value) {
        localStorage.setItem('refreshToken', refreshToken.value)
      } else {
        localStorage.removeItem('refreshToken')
      }
      if (user.value) {
        localStorage.setItem('user', JSON.stringify(user.value))
      } else {
        localStorage.removeItem('user')
      }
      return true
    } catch (error) {
      console.error('[auth] login error:', error)
      return false
    }
  }

  let isLoggingOut = false

  function logout() {
    if (isLoggingOut) return
    isLoggingOut = true
    try {
      token.value = ''
      refreshToken.value = ''
      user.value = null
      localStorage.removeItem('token')
      localStorage.removeItem('refreshToken')
      localStorage.removeItem('user')
      sessionStorage.removeItem('loginRedirectPath')

      // Use router push instead of window.location.reload to avoid
      // the flash of dashboard content followed by a blank reload
      try {
        const router = useRouter()
        if (router.currentRoute.value.path !== '/login') {
          router.replace('/login').catch(() => {})
        }
      } catch (_e) {
        // Fallback: change hash directly if pinia used outside router scope
        window.location.hash = '#/login'
      }
    } finally {
      // Reset flag after a microtick to allow multiple concurrent 401s
      setTimeout(() => { isLoggingOut = false }, 100)
    }
  }

  async function refreshSession() {
    if (!refreshToken.value) {
      throw new Error('Refresh token missing')
    }

    const res = await request.post('/auth/refresh', { refreshToken: refreshToken.value })
    const data = res.data || {}

    const newToken: string | undefined = data.token
    const newRefreshToken: string | undefined = data.refreshToken

    if (!newToken || typeof newToken !== 'string' || newToken.length < 10) {
      throw new Error('Refresh response missing valid token')
    }

    token.value = newToken
    if (newRefreshToken && typeof newRefreshToken === 'string' && newRefreshToken.length >= 10) {
      refreshToken.value = newRefreshToken
    }
    user.value = data.user || user.value

    localStorage.setItem('token', token.value)
    if (refreshToken.value) {
      localStorage.setItem('refreshToken', refreshToken.value)
    }
    if (user.value) {
      localStorage.setItem('user', JSON.stringify(user.value))
    }
    return token.value
  }

  return { token, refreshToken, user, login, logout, refreshSession }
})
