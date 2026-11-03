type Preview={mediaType:string;bytes:Uint8Array}
const MAX_BYTES=32*1024*1024
export function rememberPreview(cache:Map<string,Preview>,key:string,value:Preview):void {
  cache.delete(key)
  // Oversized PDFs transfer their original buffer to the worker without a retained copy.
  if(value.bytes.byteLength>MAX_BYTES)return
  cache.set(key,{mediaType:value.mediaType,bytes:value.bytes.slice()})
  let size=Array.from(cache.values()).reduce((total,item)=>total+item.bytes.byteLength,0)
  while(cache.size>3 || size>MAX_BYTES){
    const oldest=cache.keys().next().value
    if(oldest===undefined)break
    size-=cache.get(oldest)!.bytes.byteLength
    cache.delete(oldest)
  }
}
