import type { OnlineNetworkProbe, OnlineProbeOutcome } from '../types/video-discovery'

const explanations: Record<OnlineProbeOutcome,string> = {
  response_received:'已收到网页响应；尚未核验作品解析、播放或下载功能。',
  verification_required:'检测到人机验证或拦截页。请打开来源网页完成验证，再返回重试。',
  restricted:'网站拒绝访问。请打开来源网页检查验证或登录要求，也可检查当前线路。',
  rate_limited:'网站限制了请求频率，请稍后重试。',
  proxy_auth_required:'代理要求身份认证，请检查代理配置。',
  server_error:'网页或网关返回服务器错误，请稍后重试或检查线路。',
  http_error:'网站返回异常 HTTP 状态，请打开来源网页查看具体情况。'
}
export function onlineProbeMessage(result: OnlineNetworkProbe): string {
  return `${explanations[result.outcome]} HTTP ${result.status}。当前路由：${result.resolved || '未知'}。${result.sampleTruncated?'仅检查了网页开头的内容。':''}`
}
