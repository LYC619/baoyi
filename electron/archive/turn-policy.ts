/** Keep ambiguous follow-ups on the full task route; never guess away attached resources. */
export function archiveTurnMode(text:string,hasContext:boolean,existingSession:boolean):'chat'|'archive'{
  if(hasContext)return 'archive'
  const message=text.trim()
  if(/^(你好|您好|嗨|哈[喽啰]|早上好|晚上好|晚安|早安|谢谢|多谢|再见|hello|hi|hey|thanks)[！!。,.，\s]*$/i.test(message))return 'chat'
  if(existingSession||message.length>1200)return 'archive'
  if(/文档|文件|资料|项目|精读|归档|库|下载|目录|路径|分类|分组|标签|备注|记住|记忆|待办|订阅|设备|技能|方法|查找|搜索|联网|查询|整理|保存|修改|删除|撤销|回滚|读取|打开|本地|附件|之前|上次|刚才|这份|这本|这个|这些|软件|游戏|影视|视频|音频|漫画|图片|相册|书籍|小说|论文|笔记|摘录|书签|高亮|背包|资产|经历|指标|测量|简历|合同|证书|便签|关联|核验|定位|恢复|重命名|合并|补全|历史|会话|到期|续费|暂缓|逾期|多少钱|年费|月费|买过|装过|玩过|看过|读过|听过|存过|收藏|库存|多少部|多少个|几本|几首|有哪些|在哪|找找|帮我找|什么时候|\b(read|file|folder|project|archive|search|find|save|delete|memory|remember|skill|todo|library|undo|check|link|git|prompt|note|notes|book|pdf|video|game|image|comic|audio|locate|relocate|organize|rename|expire|expires|subscription|installed|played|watched|saved)\b/i.test(message))return 'archive'
  return 'chat'
}
export const CHAT_SYSTEM='你是抱一中的 Hermes 助理。用简洁自然的中文回答日常问题，不凭空声称已经读取或修改本地资料。当前是轻量问答，不附带资料库工具；涉及本地资料或需执行操作时，请用户明确对象和要求。'
