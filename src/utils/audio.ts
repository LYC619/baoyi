export const AUDIO_EXTENSIONS = new Set(['.mp3','.flac','.wav','.m4a','.aac','.ogg','.opus','.wma','.aiff','.aif','.ape','.alac'])
export function isAudioFile(file: string): boolean { return AUDIO_EXTENSIONS.has(file.slice(file.lastIndexOf('.')).toLowerCase()) }
export interface AudioMetadata { title:string; artist:string; album:string; track:number; sampleRate:number; bitDepth:number; bitRate:number }
