import {expect,test} from 'bun:test';
import {contentPath,createContentManifest,validateContentManifest,verifyContentFiles,MAX_CONTENT_FILE_BYTES} from './ContentPackage';
const bytes=new Uint8Array([1,2,3]);
test('manifest is canonical across selection order and filename case',async()=>{
    expect(await createContentManifest([{path:'Rules.INI',bytes},{path:'a.map',bytes}])).toEqual(await createContentManifest([{path:'a.map',bytes},{path:'rules.ini',bytes}]));
});
test('manifest rejects traversal, executable/archive content, duplicates and size/hash tampering',async()=>{
    for(const path of ['../evil.ini','dir/rules.ini','C:\\a.map','retail.mix','code.js','a..ini']) expect(()=>contentPath(path)).toThrow();
    await expect(createContentManifest([{path:'a.map',bytes},{path:'A.MAP',bytes}])).rejects.toThrow();
    const manifest=await createContentManifest([{path:'a.map',bytes}]);
    await expect(validateContentManifest({...manifest,totalBytes:999})).rejects.toThrow();
    await expect(validateContentManifest({...manifest,files:[{...manifest.files[0],size:MAX_CONTENT_FILE_BYTES+1}]})).rejects.toThrow();
    await expect(verifyContentFiles(manifest,[{path:'a.map',bytes:new Uint8Array([3,2,1])}])).rejects.toThrow('checksum');
});

import {sha256Portable} from './Sha256';
import {sha256} from './ContentPackage';
test('portable SHA-256 matches published vectors and WebCrypto across block boundaries',async()=>{
    expect(sha256Portable(new Uint8Array())).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
    expect(sha256Portable(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    for(const length of [55,56,63,64,65,127,1024,8193]) {
        const bytes=Uint8Array.from({length},(_,i)=>i%251);
        expect(sha256Portable(bytes)).toBe(await sha256(bytes));
    }
    expect(sha256Portable(new Uint8Array(1000000).fill(97))).toBe('cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0');
});
test('content hashing remains available without WebCrypto',async()=>{
    const descriptor=Object.getOwnPropertyDescriptor(globalThis,'crypto');
    Object.defineProperty(globalThis,'crypto',{value:undefined,configurable:true});
    try {expect(await sha256(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');}
    finally {if(descriptor)Object.defineProperty(globalThis,'crypto',descriptor);else delete (globalThis as any).crypto;}
});
