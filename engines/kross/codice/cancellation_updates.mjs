/** Explicit user cancellations. No absence-based deletion and no API calls. */
const clone=value=>JSON.parse(JSON.stringify(value));
const normalize=value=>String(value??'').normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().match(/[\p{L}\p{N}]+/gu)?.sort().join(' ')??'';
const cancelledStatuses=new Set(['cancellata','cancellato','annullata']);
const isExplicitCancellation=booking=>cancelledStatuses.has(String(booking.status??'').normalize('NFD')
  .replace(/\p{M}/gu,'').toLowerCase().trim());
const nextDay=date=>new Date(Date.parse(date+'T00:00:00Z')+86400000).toISOString().slice(0,10);

export function prepareConfirmedCancellations(bookings,state,calendar,entries,activeDates){
  const source=clone(bookings),conflicts=[],warnings=[],applied=[];
  const active=new Set(activeDates);
  for(const entry of entries.filter(entry=>entry.calendarId===calendar.id&&entry.dates.some(date=>active.has(date)))){
    const binding=state?.bindings?.[entry.bookingId];
    const related=source.filter(booking=>booking.room===calendar.roomName&&String(booking.id).trim()===entry.bookingId);
    const expectedDates=new Set(entry.dates);
    const changed=binding&&(!Array.isArray(binding.dates)||normalize(binding.reference)!==normalize(entry.reference)
      ||binding.dates.some(date=>!expectedDates.has(date)||normalize(binding.values?.[date])!==normalize(entry.reference)));
    // An explicit cancellation corroborates the same room/ID/stay even when
    // the export shortens the guest name. A confirmed or unknown-status row
    // must still match the saved name before a tombstone may suppress it.
    const sourceChanged=related.some(booking=>(!isExplicitCancellation(booking)
      && normalize(booking.reference)!==normalize(entry.reference))
      ||booking.checkIn!==entry.dates[0]||booking.checkOut!==nextDay(entry.dates.at(-1)));
    if(changed||sourceChanged||related.length>1){
      conflicts.push({type:'confirmed_cancellation_changed',sheetName:calendar.sheetName,bookingId:entry.bookingId,
        reference:entry.reference,dates:entry.dates.filter(date=>active.has(date)),
        message:'La prenotazione già segnata come cancellata ha dati diversi: controllare prima di riattivarla.'});
      continue;
    }
    for(let index=source.length-1;index>=0;index--)if(source[index].room===calendar.roomName&&String(source[index].id).trim()===entry.bookingId)source.splice(index,1);
    source.push({id:entry.bookingId,room:calendar.roomName,reference:entry.reference,status:'Cancellata',
      checkIn:entry.dates[0],checkOut:nextDay(entry.dates.at(-1))});
    applied.push(entry);
    warnings.push({type:'confirmed_cancellation_applied',bookingId:entry.bookingId,reference:entry.reference,
      dates:entry.dates.filter(date=>active.has(date)),
      message:`Cancellazione confermata: ${entry.reference}. Si liberano soltanto le date presenti nell’Excel.`});
    if(entry.dates.some(date=>!active.has(date)))warnings.push({type:'cancellation_dates_outside_file',bookingId:entry.bookingId,
      reference:entry.reference,message:'Alcune date della prenotazione cancellata non sono nell’Excel: vengono lasciate invariate.'});
  }
  return {bookings:source,conflicts,warnings,applied};
}
