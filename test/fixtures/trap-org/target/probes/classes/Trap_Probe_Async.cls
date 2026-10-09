/**
 * The asynchronous Apex a probe item starts: a queueable job and a future call,
 * each leaving a marker under the item's tag once it runs. Whether either runs
 * after the insert that started it was rolled back is what the probe reads.
 */
public with sharing class Trap_Probe_Async implements Queueable {
    private final List<String> tags;

    public Trap_Probe_Async(List<String> tags) {
        this.tags = tags;
    }

    public void execute(QueueableContext context) {
        mark(tags, 'queueable');
    }

    @future
    public static void markLater(List<String> tags) {
        mark(tags, 'future');
    }

    public static void mark(List<String> tags, String source) {
        List<Trap_Probe_Log__c> logs = new List<Trap_Probe_Log__c>();
        for (String tag : tags) {
            logs.add(new Trap_Probe_Log__c(Name = tag, Source__c = source));
        }
        insert logs;
    }
}
