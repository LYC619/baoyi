import type {ReadingLocation} from '../types/workspace.ts'
export interface WorkspaceSource {documentId:string;name:string;quote:string;location:ReadingLocation;line?:number;label:string}
