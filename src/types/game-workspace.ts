export interface GameNote {id:string;resource_id:string;title:string;body:string;sort:number;created_at:number;updated_at:number}
export interface GameNoteInput {id?:string;title:string;body:string;expectedUpdatedAt?:number}
export interface GamePreview {path:string;kind:'md'|'txt'|'xlsx'|'unsupported';text:string;bytes:number;truncated:boolean;sheets?:string[];rows?:string[][]}
export interface GameLaunchOptions {entry?:string;trainers?:string[]}
