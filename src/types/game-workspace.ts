export interface GameNote {id:string;resource_id:string;title:string;body:string;sort:number;created_at:number;updated_at:number}
export interface GameNoteInput {id?:string;title:string;body:string;expectedUpdatedAt?:number}
export interface GameExcelSheet {name:string;rows:string[][];truncated:boolean}
export interface GamePreview {path:string;kind:'md'|'txt'|'xlsx'|'pdf'|'unsupported';text:string;bytes:number;truncated:boolean;sheets?:string[];rows?:string[][];allSheets?:GameExcelSheet[];images?:Record<string,string>;data?:Uint8Array}
export interface GameLaunchOptions {entry?:string;trainers?:string[]}
