@IsTest
private class Trap_Probe_AsyncTest {
    @IsTest
    static void insertingAnItemLeavesAMarkerFromTheQueueableAndTheFutureCall() {
        Test.startTest();
        insert new Trap_Probe_Item__c(Name = 'Trap Probe Test');
        Test.stopTest();

        Set<String> sources = new Set<String>();
        for (Trap_Probe_Log__c log : [SELECT Source__c FROM Trap_Probe_Log__c WHERE Name = 'Trap Probe Test']) {
            sources.add(log.Source__c);
        }
        Assert.isTrue(sources.contains('queueable'), 'no marker from the queueable job: ' + sources);
        Assert.isTrue(sources.contains('future'), 'no marker from the future call: ' + sources);
    }
}
