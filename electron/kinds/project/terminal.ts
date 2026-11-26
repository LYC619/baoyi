import path from 'node:path'

/** Literal values only. The helper opens an interactive terminal; it never runs project scripts. */
export function projectTerminalLaunch(cwd:string,systemRoot:string) {
  if(!path.isAbsolute(cwd)||cwd.includes('\0'))throw new Error('终端工作目录无效')
  const executable=path.join(systemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe')
  const literal=(text:string)=>"'"+text.replaceAll("'","''")+"'"
  const command=`$ErrorActionPreference = 'Stop'; $terminal = Start-Process -FilePath ${literal(executable)} -WorkingDirectory ${literal(cwd)} -ArgumentList @('-NoLogo', '-NoProfile', '-NoExit') -WindowStyle Normal -PassThru; $terminal.Id`
  return {executable,args:['-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')]}
}
