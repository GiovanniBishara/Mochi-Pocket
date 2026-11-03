'use strict';
(function(root,factory){
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.mochiTaxQuick=api;
})(typeof window==='object'?window:globalThis,function(){
  const DAY_MS=86400000;
  const count=value=>Number.isSafeInteger(value)&&value>=0;
  const positiveTotal=value=>count(value)&&value>0&&Number.isSafeInteger(value*365*950);
  const text=value=>typeof value==='string'&&value.trim().length>0;
  const own=(value,key)=>Object.hasOwn(value,key);
  const reasons={
    invalid:'Soggiorno non valido: verifica i dettagli.',
    review:'Il soggiorno richiede una verifica dei dettagli prima della conferma.',
    dates:'Verifica le date del soggiorno nei dettagli.',
    warnings:'Controlla gli avvisi del soggiorno prima della conferma.',
    missing_total:'Indica il numero totale degli ospiti.',
    saved_counts:'Verifica i conteggi già salvati nei dettagli.'
  };
  function validDates(stay){
    const values=[stay.arrival,stay.departure];
    if(values.some(value=>typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)))return false;
    const stamps=values.map(value=>Date.parse(value+'T00:00:00.000Z'));
    if(stamps.some((stamp,index)=>!Number.isFinite(stamp)||new Date(stamp).toISOString().slice(0,10)!==values[index]))return false;
    const nights=(stamps[1]-stamps[0])/DAY_MS;
    return Number.isInteger(nights)&&nights>=1&&nights<=365;
  }
  function periodNights(stay,period){
    if(!stay||typeof stay!=='object'||Array.isArray(stay)||!validDates(stay)
      ||!period||typeof period!=='object'||Array.isArray(period)
      ||!Number.isInteger(period.year)||period.year<1900||period.year>9998)return null;
    const {year,month,quarter}=period,allocation=period.allocation??'arrival';
    if(!['arrival','nights'].includes(allocation))return null;
    if(month!==undefined&&(!Number.isInteger(month)||month<1||month>12))return null;
    if(quarter!==undefined&&(!Number.isInteger(quarter)||quarter<1||quarter>4))return null;
    if(month===undefined&&quarter===undefined)return null;
    if(month!==undefined&&quarter!==undefined&&Math.ceil(month/3)!==quarter)return null;
    const firstMonth=month??(quarter-1)*3+1;
    const periodStart=Date.UTC(year,firstMonth-1,1);
    const periodEnd=Date.UTC(year,firstMonth-1+(month===undefined?3:1),1);
    const arrival=Date.parse(stay.arrival+'T00:00:00.000Z');
    const departure=Date.parse(stay.departure+'T00:00:00.000Z');
    const total=(departure-arrival)/DAY_MS;
    const inPeriod=allocation==='arrival'?(arrival>=periodStart&&arrival<periodEnd?total:0)
      :Math.max(0,(Math.min(departure,periodEnd)-Math.max(arrival,periodStart))/DAY_MS);
    return {total,inPeriod,outsidePeriod:total-inPeriod};
  }
  function suggestedCollection(channel){
    if(typeof channel!=='string')return null;
    const normalized=channel.trim().toLowerCase();
    return ['airbnb','airbnb.com'].includes(normalized)?'portal'
      :['booking','booking.com','diretta','diretto','frontoffice','direct','manuale','sito','telefono'].includes(normalized)?'host':null;
  }
  function blocked(code,extra={}){
    return {eligible:false,reasonCode:code,reason:reasons[code],total:null,adults:null,minors:null,
      otherExemptAdults:0,exemptionReason:'',collection:null,basis:'all_adults',needsConfirmation:true,
      editableTotal:false,...extra};
  }
  function quickProposal(stay){
    if(!stay||typeof stay!=='object'||Array.isArray(stay)||!text(stay.id)||!text(stay.name)
      ||!text(stay.sourceFingerprint)||!/^[A-Z]$/.test(stay.initial||''))return blocked('invalid');
    if(stay.cancelled===true||stay.source?.cancelled===true||stay.missing===true||stay.needsReview===true
      ||!['pending','confirmed'].includes(stay.status))return blocked('review');
    if(!validDates(stay))return blocked('dates');
    const saved=stay.status==='confirmed';
    if(saved){
      const total=stay.adults+stay.minors,other=stay.otherExemptAdults??0;
      if(stay.confirmed!==true||stay.sameDatesConfirmed!==true||!count(stay.adults)||!count(stay.minors)
        ||!positiveTotal(total)||!count(other)||other>stay.adults||!count(stay.previousConsecutiveNights??0)
        ||!['host','portal'].includes(stay.collection)||(other>0&&!text(stay.exemptionReason)))return blocked('saved_counts');
      return {eligible:true,reasonCode:null,reason:null,total,adults:stay.adults,minors:stay.minors,
        otherExemptAdults:other,exemptionReason:stay.exemptionReason||'',collection:stay.collection,
        basis:'saved',needsConfirmation:true,editableTotal:false};
    }
    if(Array.isArray(stay.warnings)&&stay.warnings.length)return blocked('warnings');
    const total=stay.guestCount;
    const collection=suggestedCollection(stay.channel);
    if(!positiveTotal(total))return blocked('missing_total',{editableTotal:true,collection});
    const hint=stay.guestBreakdown??stay.source?.guestBreakdown;
    const validHint=hint&&count(hint.adults)&&count(hint.minors)&&hint.adults+hint.minors===total
      &&['kross','notes'].includes(hint.basis);
    return {eligible:true,reasonCode:null,reason:null,total,adults:validHint?hint.adults:total,
      minors:validHint?hint.minors:0,otherExemptAdults:0,exemptionReason:'',collection,
      basis:validHint?hint.basis:'all_adults',needsConfirmation:true,editableTotal:false};
  }
  function quickConfirmation(stay,input={}){
    if(!input||typeof input!=='object'||Array.isArray(input)||input.confirmed!==true)throw Error('Conferma esplicitamente i conteggi proposti.');
    let proposal=quickProposal(stay);
    if(proposal.editableTotal&&positiveTotal(input.total))proposal=quickProposal({...stay,guestCount:input.total});
    if(!proposal.eligible)throw Error(proposal.reason);
    if(own(input,'total')&&input.total!==proposal.total)throw Error('Il totale ospiti è diverso da quello già disponibile: verifica i dettagli.');
    const minors=own(input,'minors')?input.minors:proposal.minors;
    if(!count(minors)||minors>proposal.total)throw Error('Gli esenti minorenni devono essere un numero intero tra zero e il totale ospiti.');
    const adults=proposal.total-minors;
    if(proposal.otherExemptAdults>adults)throw Error('La modifica non comprende gli adulti esenti già salvati: verifica i dettagli.');
    const collection=own(input,'collection')?input.collection:proposal.collection;
    if(!['host','portal'].includes(collection))throw Error('Indica chi gestisce il versamento della tassa.');
    return {id:stay.id,initial:stay.initial,name:stay.name,arrival:stay.arrival,departure:stay.departure,
      adults,minors,otherExemptAdults:proposal.otherExemptAdults,exemptionReason:proposal.exemptionReason,
      collection,channel:typeof stay.channel==='string'?stay.channel:'',confirmed:true,sameDatesConfirmed:true,
      previousConsecutiveNights:stay.status==='confirmed'?(stay.previousConsecutiveNights??0):0,
      sourceFingerprint:stay.sourceFingerprint,manual:stay.manual===true};
  }
  return {quickProposal,quickConfirmation,periodNights};
});
