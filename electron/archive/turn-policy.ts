/** Keep ambiguous follow-ups on the full task route; never guess away attached resources. */
export function archiveTurnMode(text:string,hasContext:boolean,existingSession:boolean):'chat'|'archive'{
  if(hasContext)return 'archive'
  const message=text.trim()
  if(/^(你好|您好|嗨|哈[喽啰]|早上好|晚上好|晚安|早安|谢谢|多谢|再见|hello|hi|hey|thanks)[！!。,.，\s]*$/i.test(message))return 'chat'
  if(existingSession||message.length>1200)return 'archive'
  if(/文档|文件|资料|项目|精读|归档|库|下载|目录|路径|分类|标签|备注|记住|记忆|待办|订阅|设备|技能|方法|查找|搜索|联网|查询|整理|保存|修改|删除|撤销|读取|读取|打开|本地|附件|之前|上次|刚才|这份|这本|这个|这些|\b(read|file|folder|project|archive|search|find|save|delete|memory|remember|skill|todo|library)\b/i.test(message))return 'archive'
  return 'chat'
}
export const CHAT_SYSTEM='你是抱一中的 Hermes 助理。用简洁自然的中文回答日常问题，不凭空声称已经读取或修改本地资料。当前是轻量问答，不附带资料库工具；涉及本地资料或需执行操作时，请用户明确对象和要求。'
