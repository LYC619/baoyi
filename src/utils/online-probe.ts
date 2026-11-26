
import { tr } from '../i18n/index.ts'
import type { OnlineNetworkProbe, OnlineProbeOutcome } from '../types/video-discovery'

const explanations: Record<OnlineProbeOutcome,string> = {
  get response_received() { return tr("已收到网页响应；尚未核验作品解析、播放或下载功能。") },
  get verification_required() { return tr("检测到人机验证或拦截页。请打开来源网页完成验证，再返回重试。") },
  get restricted() { return tr("网站拒绝访问。请打开来源网页检查验证或登录要求，也可检查当前线路。") },
  get rate_limited() { return tr("网站限制了请求频率，请稍后重试。") },
  get proxy_auth_required() { return tr("代理要求身份认证，请检查代理配置。") },
  get server_error() { return tr("网页或网关返回服务器错误，请稍后重试或检查线路。") },
  get http_error() { return tr("网站返回异常 HTTP 状态，请打开来源网页查看具体情况。") }
}
export function onlineProbeMessage(result: OnlineNetworkProbe): string {
  return tr('{p0} HTTP {p1}。当前路由：{p2}。', { p0: explanations[result.outcome], p1: result.status, p2: result.resolved || tr('未知') }) + (result.sampleTruncated ? ' ' + tr('仅检查了网页开头的内容。') : '')
}
