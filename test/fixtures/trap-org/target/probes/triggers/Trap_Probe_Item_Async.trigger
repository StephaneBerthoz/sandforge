trigger Trap_Probe_Item_Async on Trap_Probe_Item__c (after insert) {
    List<String> tags = new List<String>();
    for (Trap_Probe_Item__c item : Trigger.new) {
        tags.add(item.Name);
    }
    System.enqueueJob(new Trap_Probe_Async(tags));
    Trap_Probe_Async.markLater(tags);
}
