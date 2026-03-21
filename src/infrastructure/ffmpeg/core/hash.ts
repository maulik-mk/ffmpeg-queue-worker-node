import { v7 as uuidv7 } from 'uuid';

export function generateTierUuid(): string {
   return uuidv7();
}

export function blobPathFromUuid(id: string): string {
   const cleanId = id.toLowerCase().replace(/-/g, '');

   const p1 = cleanId.slice(0, 2);
   const p2 = cleanId.slice(2, 4);
   const p3 = cleanId.slice(4, 6);

   return `${p1}/${p2}/${p3}/${id}`;
}
