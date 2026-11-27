import { getWorkingApiClient } from './working-api-service'
import { getWorkingTokenStore, subscribeWorkingIdentity } from './working-auth-store'
import { createWebTab, getWebTabContents, navigateWebTab, closeWebTab } from './web-tab-manager'

const api = 'https://pie.meetlife.com.cn'
const frontend = 'https://pi.meetlife.com.cn'
const cookieName = '__Host-copis_purchase'

/** 只交接短期购物 cookie；不把桌面登录令牌放进网页、URL、历史记录或脚本。 */
export async function openWorkingPurchaseTab(mode: 'diamonds' | 'vip'): Promise<void> {
  if (mode !== 'diamonds' && mode !== 'vip') throw new Error('无效的购买入口')
  const store = getWorkingTokenStore()
  const user = await getWorkingApiClient().getCurrentUser()
  const current = () => String(store.getUser()?.id ?? '') === String(user.id)
  const token = store.getToken()
  if (!token) throw new Error('请先登录 Copis')
  if (!current()) throw new Error('购买账号未同步，请刷新账户设置后重试')
  const response = await fetch(`${api}/pi-api/api/pay/desktop-session`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(12000),
  })
  if (!response.ok) throw new Error(response.status === 403 ? '当前账号不能发起购买' : '购物登录失败，请重新登录 Copis 后重试')
  const body = await response.json()
  const cookie = response.headers.getSetCookie().find(value => value.startsWith(`${cookieName}=`))
  const value = cookie?.match(/^__Host-copis_purchase=([A-Za-z0-9_-]{43});/)?.[1]
  const ttl = Number(cookie?.match(/;\s*Max-Age=(\d+)/i)?.[1])
  if (!value || !(ttl > 0 && ttl <= 600) || String(body.user_id) !== String(user.id) || !current()) throw new Error('购买账号发生变化，请重试')
  const {createdTabId} = createWebTab({url:'about:blank', activate:true, incognito:true})
  const contents = getWebTabContents(createdTabId)
  if (!contents) { closeWebTab(createdTabId); throw new Error('无法创建购买页签') }
  const unsubscribe = subscribeWorkingIdentity(id => { if (String(id ?? '') !== String(user.id) && getWebTabContents(createdTabId)) closeWebTab(createdTabId) })
  contents.once('destroyed', unsubscribe)
  try {
    await contents.session.cookies.set({url:api,name:cookieName,value,path:'/',secure:true,httpOnly:true,sameSite:'strict',expirationDate:Date.now()/1000+ttl})
    if (!current() || contents.isDestroyed()) throw new Error('购买页已关闭或账号已切换')
    navigateWebTab({tabId:createdTabId,url:`${frontend}/working/settings?purchase=${mode}`})
  } catch (error) {if(getWebTabContents(createdTabId)) closeWebTab(createdTabId);throw error}
}
