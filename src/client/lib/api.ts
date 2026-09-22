import { hc } from 'hono/client'
import type { AppType } from '@server/index'

const api = hc<AppType>('/')
export default api