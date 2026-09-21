import axios from 'axios'
import { ElMessage } from 'element-plus'
import { useAuthStore } from '../stores/auth'

const service = axios.create({
  baseURL: '/ct-api',
  timeout: 10000
})

let refreshPromise: Promise<string> | null = null

// Request interceptor
service.interceptors.request.use(
  (config) => {
    const authStore = useAuthStore()
    if (authStore.token) {
      config.headers['Authorization'] = `Bearer ${authStore.token}`
    }
    return config
  },
  (error) => {
    return Promise.reject(error)
  }
)

// Response interceptor
service.interceptors.response.use(
  (response) => {
    return response
  },
  async (error) => {
    if (error.response && error.response.status === 401) {
      const originalRequest = error.config
      const requestUrl = originalRequest?.url || ''
      const isLoginRequest = requestUrl.includes('/auth/login')
      const isRefreshRequest = requestUrl.includes('/auth/refresh')

      if (isLoginRequest || isRefreshRequest) {
        return Promise.reject(error)
      }

      const authStore = useAuthStore()

      // CRITICAL FIX: If no refreshToken is available (e.g. backend did not
      // return one, or it was empty/invalid), SKIP both refresh attempt AND
      // forced logout. Otherwise a single 401 right after login would throw
      // the user back to the login page in a split second.
      if (!authStore.refreshToken) {
        console.warn('[request] 401 received but no refreshToken available. ' +
          'Skipping refresh + logout to avoid login-loop flash. url:', requestUrl)
        return Promise.reject(error)
      }

      if (!originalRequest) {
        authStore.logout()
        ElMessage.error('Session expired, please login again')
        return Promise.reject(error)
      }

      if (!originalRequest._retry) {
        originalRequest._retry = true
        try {
          if (!refreshPromise) {
            refreshPromise = authStore.refreshSession().finally(() => {
              refreshPromise = null
            })
          }
          const token = await refreshPromise
          originalRequest.headers = originalRequest.headers || {}
          originalRequest.headers['Authorization'] = `Bearer ${token}`
          return service(originalRequest)
        } catch (refreshError) {
          authStore.logout()
          ElMessage.error('Session expired, please login again')
        }
      } else {
        authStore.logout()
        ElMessage.error('Session expired, please login again')
      }
    } else {
      // Do NOT spam the user with generic "Request failed" toasts for every
      // rejected promise. Business errors that already carry a message will be
      // surfaced by the caller.
      const hasBusinessMsg = !!(error?.response?.data &&
        (error.response.data.error || error.response.data.message))
      if (!hasBusinessMsg && error.message && error.code !== 'ERR_CANCELED') {
        ElMessage.error(error.message)
      }
    }
    return Promise.reject(error)
  }
)

export default service
