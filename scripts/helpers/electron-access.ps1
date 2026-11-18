param([string[]]$Paths)
$ErrorActionPreference='Stop'
# Read-only diagnostic: creates a MORE restricted token for AccessCheck only.
# Never impersonates the token, starts Electron, or changes a file ACL.
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class RuntimeReadCheck {
  [StructLayout(LayoutKind.Sequential)] struct SidAttr { public IntPtr Sid; public uint Attributes; }
  [StructLayout(LayoutKind.Sequential)] struct GroupHead { public uint Count; public SidAttr First; }
  [StructLayout(LayoutKind.Sequential)] struct Mapping { public uint Read,Write,Execute,All; }
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr h);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool OpenProcessToken(IntPtr p,uint access,out IntPtr token);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool GetTokenInformation(IntPtr t,int kind,IntPtr data,int size,out int needed);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool CreateRestrictedToken(IntPtr t,uint flags,uint disabled,IntPtr disable,uint deleted,IntPtr privileges,uint count,[In] SidAttr[] restricted,out IntPtr result);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool SetTokenInformation(IntPtr t,int kind,IntPtr data,int size);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSidToSid(string text,out IntPtr sid);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool DuplicateTokenEx(IntPtr t,uint access,IntPtr attr,int level,int type,out IntPtr result);
  [DllImport("advapi32.dll",CharSet=CharSet.Unicode)] static extern uint GetNamedSecurityInfo(string name,int type,uint info,out IntPtr owner,out IntPtr group,out IntPtr dacl,out IntPtr sacl,out IntPtr descriptor);
  [DllImport("advapi32.dll",SetLastError=true)] static extern bool AccessCheck(IntPtr sd,IntPtr token,uint desired,ref Mapping map,IntPtr privileges,ref uint length,out uint granted,out bool allowed);
  static void Check(bool ok,string step){if(!ok)throw new Win32Exception(Marshal.GetLastWin32Error(),step);}
  static IntPtr Info(IntPtr token,int kind){int needed;GetTokenInformation(token,kind,IntPtr.Zero,0,out needed);IntPtr p=Marshal.AllocHGlobal(needed);try{Check(GetTokenInformation(token,kind,p,needed,out needed),"token information");return p;}catch{Marshal.FreeHGlobal(p);throw;}}
  static bool CanRead(string path,IntPtr token){
    IntPtr sd,owner,group,dacl,sacl;uint error=GetNamedSecurityInfo(path,1,0x17,out owner,out group,out dacl,out sacl,out sd);
    if(error!=0)throw new Win32Exception((int)error,"file security descriptor");
    IntPtr privileges=Marshal.AllocHGlobal(4096);
    try{Mapping map=new Mapping{Read=0x120089,Write=0x120116,Execute=0x1200a0,All=0x1f01ff};uint size=4096,granted;bool allowed;
      Check(AccessCheck(sd,token,0x120089,ref map,privileges,ref size,out granted,out allowed),"AccessCheck");return allowed;
    }finally{Marshal.FreeHGlobal(privileges);LocalFree(sd);}
  }
  public static string[] Run(string[] paths){
    IntPtr original=IntPtr.Zero,restricted=IntPtr.Zero,probe=IntPtr.Zero,baseline=IntPtr.Zero,user=IntPtr.Zero,groups=IntPtr.Zero,low=IntPtr.Zero,label=IntPtr.Zero;
    try{
      Check(OpenProcessToken(GetCurrentProcess(),0xf01ff,out original),"open current token");
      user=Info(original,1);groups=Info(original,2);
      var sids=new List<SidAttr>();sids.Add(new SidAttr{Sid=Marshal.ReadIntPtr(user),Attributes=0});
      int count=Marshal.ReadInt32(groups),offset=(int)Marshal.OffsetOf(typeof(GroupHead),"First"),stride=Marshal.SizeOf(typeof(SidAttr));
      for(int i=0;i<count;i++){var item=(SidAttr)Marshal.PtrToStructure(IntPtr.Add(groups,offset+i*stride),typeof(SidAttr));if((item.Attributes&0x20)==0)sids.Add(new SidAttr{Sid=item.Sid,Attributes=0});}
      Check(CreateRestrictedToken(original,0,0,IntPtr.Zero,0,IntPtr.Zero,(uint)sids.Count,sids.ToArray(),out restricted),"create restricted diagnostic token");
      Check(ConvertStringSidToSid("S-1-16-4096",out low),"low integrity SID");
      label=Marshal.AllocHGlobal(stride+32);Marshal.StructureToPtr(new SidAttr{Sid=low,Attributes=0x20},label,false);
      Check(SetTokenInformation(restricted,25,label,stride+32),"lower diagnostic integrity");
      Check(DuplicateTokenEx(restricted,0xf01ff,IntPtr.Zero,2,2,out probe),"duplicate diagnostic token");
      Check(DuplicateTokenEx(original,0xf01ff,IntPtr.Zero,2,2,out baseline),"duplicate baseline token");
      var results=new List<string>();foreach(string path in paths)results.Add(path+"|current="+CanRead(path,baseline)+"|restrictedLow="+CanRead(path,probe));return results.ToArray();
    }finally{if(probe!=IntPtr.Zero)CloseHandle(probe);if(baseline!=IntPtr.Zero)CloseHandle(baseline);if(restricted!=IntPtr.Zero)CloseHandle(restricted);if(original!=IntPtr.Zero)CloseHandle(original);if(user!=IntPtr.Zero)Marshal.FreeHGlobal(user);if(groups!=IntPtr.Zero)Marshal.FreeHGlobal(groups);if(label!=IntPtr.Zero)Marshal.FreeHGlobal(label);if(low!=IntPtr.Zero)LocalFree(low);}
  }
}
'@
[RuntimeReadCheck]::Run($Paths)
