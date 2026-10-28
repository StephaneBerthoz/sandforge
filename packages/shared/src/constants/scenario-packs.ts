import type { ScenarioPack } from '../types/scenario.types.js';

/*
 * The scenario packs SandForge ships, written by hand and reviewed as code.
 *
 * They are in English, the language an agent is set up in first. Each states
 * its rules once, in its articles; the cases, their comments and the
 * utterances follow those rules, so an agent answering from the articles
 * answers each test the way its expected outcome says. A fact is quoted from
 * its article's body word for word, which the schema checks.
 *
 * No text names a real company, product or person, nor holds an email
 * address or a phone number: the people and companies are the run's, filled
 * in through the placeholders, and their addresses and numbers reach nobody.
 */

/** An online store selling office and shop supplies to small businesses. */
export const RETAIL_ORDERS_PACK: ScenarioPack = {
  version: 1,
  id: 'retail-orders',
  name: 'Retail orders',
  language: 'en_US',
  businessContext:
    'An online store that sells office and shop supplies to small businesses: paper, ink, ' +
    'packaging, furniture and small electronics, delivered by carrier. Customers order on the ' +
    'website and write to support by email, by phone or through the web form.',
  customers: { count: 10, industry: 'Retail' },
  topics: [
    {
      key: 'damaged-parcel',
      label: 'Damaged parcel',
      article: {
        title: 'What to do when a parcel arrives damaged',
        summary:
          'Report the damage within 7 days of delivery with photos. Support offers a replacement ' +
          'or a refund, and the carrier collects the damaged goods free of charge.',
        body: [
          'If a parcel arrives damaged, report it within 7 days of delivery from the order page or ' +
            'by replying to the delivery confirmation. Include photos of the outer box, the packing ' +
            'and the damaged items, and keep the original packaging until the case is closed.',
          'Once the photos are received, support offers a replacement or a full refund of the ' +
            'damaged items, whichever the customer prefers. A replacement ships within 2 working ' +
            'days. A refund goes back to the original payment method within 5 working days.',
          'The carrier collects the damaged goods free of charge. Support books the collection ' +
            'when the replacement or the refund is agreed: the customer does not pay for a return ' +
            'label.',
          'Damage reported after 7 days is handled as a warranty claim when the item is covered by ' +
            'a warranty.',
        ].join('\n\n'),
        facts: [
          'within 7 days of delivery',
          'photos of the outer box, the packing and the damaged items',
          'A replacement ships within 2 working days',
          'The carrier collects the damaged goods free of charge',
        ],
      },
      caseTemplates: [
        {
          subject: 'Order arrived with a crushed box and broken items',
          description:
            'Hello, this is {firstName} from {company}. Our order arrived this morning with the ' +
            'box crushed on one side, and two of the six desk lamps inside are broken.',
          priority: 'Medium',
          origin: 'Email',
          followUp:
            'Hi again, I sent the photos of the box and the lamps yesterday. Can you confirm ' +
            'whether you will send replacements?',
          resolution: [
            'Photos received: the outer box is crushed and two lamps are broken. Offered a ' +
              'replacement or a refund of the two lamps; the customer chose a replacement.',
            'Replacement of the two desk lamps shipped. Carrier collection of the broken lamps ' +
              'booked free of charge. Case closed.',
          ],
        },
        {
          subject: 'Toner cartridges leaking on arrival',
          description:
            'Hi, {firstName} at {company} here. The box of toner cartridges we received is stained ' +
            'and three cartridges are leaking. We cannot use them.',
          priority: 'High',
          origin: 'Web',
          followUp:
            'Any news? We are running out of toner and need the replacement cartridges this week.',
          resolution: [
            'Asked for photos of the box, the packing and the cartridges. Photos received the same ' +
              'day: three cartridges leaking.',
            'The customer preferred a refund. Refund of the three cartridges issued to the original ' +
              'payment method; carrier collection booked free of charge. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, my email is {email}. The parcel I received is damaged, what should I do?',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" from the email address, asks for ' +
            'photos of the outer box, the packing and the damaged items, and says a replacement ' +
            'or a refund is offered.',
        },
        {
          text: 'Our order arrived broken. Do we have to pay to send the damaged items back?',
          expectedOutcome:
            'The agent says the carrier collects the damaged goods free of charge, so no return ' +
            'label is needed.',
        },
        {
          text: 'I only noticed the damage today and the parcel came three days ago. Is it too late?',
          expectedOutcome:
            'The agent says damage is reported within 7 days of delivery, so it is not too late, ' +
            'and explains how to report it with photos.',
        },
      ],
    },
    {
      key: 'refund',
      label: 'Refund',
      article: {
        title: 'Refunds: how and when you are paid back',
        summary:
          'Unused items can be returned within 30 days of delivery with a free return label. The ' +
          'refund is issued to the original payment method once the items are checked.',
        body: [
          'Unused items can be returned for a refund within 30 days of delivery. Start the return ' +
            'from the order page: a free return label is emailed to the address of the account.',
          'Once the returned items reach the warehouse, they are checked within 2 working days. ' +
            'The refund is issued to the original payment method, and the bank usually shows it ' +
            'within 5 working days after that.',
          'Delivery charges are refunded when the whole order is returned, or when the return is ' +
            'due to our mistake. Customised items, such as printed stationery, cannot be refunded ' +
            'unless they arrived damaged or faulty.',
          'A refund for a damaged parcel needs no return: see the article on damaged parcels.',
        ].join('\n\n'),
        facts: [
          'within 30 days of delivery',
          'a free return label',
          'refund is issued to the original payment method',
          'Customised items, such as printed stationery, cannot be refunded',
        ],
      },
      caseTemplates: [
        {
          subject: 'Refund not received for returned chairs',
          description:
            'Hello, {firstName} from {company}. We returned two office chairs two weeks ago and ' +
            'have not seen the refund yet.',
          priority: 'Medium',
          origin: 'Email',
          followUp: 'Still no refund on our bank statement. Could you check where it is?',
          resolution: [
            'The warehouse confirmed the two chairs arrived and passed the check.',
            'Refund issued to the original payment method; told the customer the bank shows it ' +
              'within 5 working days. Case closed.',
          ],
        },
        {
          subject: 'Return of an unopened paper order',
          description:
            'Hi, this is {firstName} at {company}. We ordered too much printer paper. Can we return ' +
            'the unopened boxes for a refund?',
          priority: 'Low',
          origin: 'Web',
          followUp: 'We have not received the return label yet. Where should we look for it?',
          resolution: [
            'Order delivered ten days ago, within 30 days: return accepted. Free return label ' +
              'emailed to the address of the account.',
            'Boxes received unopened. Refund issued to the original payment method. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'This is {email}. When will I get my refund?',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and explains that returned items are ' +
            'checked within 2 working days and the refund is issued to the original payment method.',
        },
        {
          text: 'Can I get a refund on business cards printed with our logo?',
          expectedOutcome:
            'The agent explains that customised items such as printed stationery cannot be ' +
            'refunded unless they arrived damaged or faulty.',
        },
        {
          text: 'Do I have to pay for the return shipping?',
          expectedOutcome:
            'The agent says a free return label is emailed when the return is started from the ' +
            'order page.',
        },
      ],
    },
    {
      key: 'late-delivery',
      label: 'Late delivery',
      article: {
        title: 'Late deliveries and tracking',
        summary:
          'Most orders are delivered within 3 working days. Support opens an inquiry with the ' +
          'carrier when the tracking stops, and a parcel late by 10 working days is treated as lost.',
        body: [
          'Orders placed before 2 pm on a working day leave our warehouse the same day, and most ' +
            'are delivered within 3 working days. The tracking link is in the dispatch email and ' +
            'on the order page.',
          "If the tracking has not changed for 2 working days, the parcel may be held at the carrier's " +
            'depot. Support opens an inquiry with the carrier, which answers within 48 hours.',
          'A parcel not delivered within 10 working days of dispatch is treated as lost: support ' +
            'sends a replacement at no cost or refunds the order, as the customer prefers.',
          'Express delivery charges are refunded when an express parcel arrives late.',
        ].join('\n\n'),
        facts: [
          'Orders placed before 2 pm on a working day leave our warehouse the same day',
          'opens an inquiry with the carrier',
          'not delivered within 10 working days of dispatch is treated as lost',
          'Express delivery charges are refunded when an express parcel arrives late',
        ],
      },
      caseTemplates: [
        {
          subject: 'Order still not delivered after a week',
          description:
            'Hello, {firstName} here from {company}. Our order was dispatched a week ago and the ' +
            'tracking has not moved for four days.',
          priority: 'High',
          origin: 'Phone',
          followUp: 'The tracking still says in transit. Has the carrier answered your inquiry?',
          resolution: [
            'Tracking unchanged for four working days. Opened an inquiry with the carrier.',
            'The carrier found the parcel at its depot and delivered it the next day. Case closed.',
          ],
        },
        {
          subject: 'Express delivery arrived two days late',
          description:
            'Hi, {firstName} at {company}. We paid for express delivery and the parcel arrived two ' +
            'days late. We would like the express charge back.',
          priority: 'Low',
          origin: 'Email',
          followUp: 'Could you confirm when the express charge will be refunded?',
          resolution: [
            'Tracking confirms the express parcel arrived two days after the promised date.',
            'Express delivery charge refunded to the original payment method. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, I am writing from {email}. Where is my order? It should have arrived by now.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}", gives the tracking details and explains ' +
            'that support opens an inquiry with the carrier when the tracking has not changed for 2 ' +
            'working days.',
        },
        {
          text: 'My parcel has been stuck for two weeks. Is it lost?',
          expectedOutcome:
            'The agent explains that a parcel not delivered within 10 working days of dispatch is ' +
            'treated as lost, and offers a replacement at no cost or a refund.',
        },
      ],
    },
    {
      key: 'address-change',
      label: 'Change of delivery address',
      article: {
        title: 'Changing the delivery address of an order',
        summary:
          'The address can be changed on the order page until dispatch. After dispatch, support can ' +
          'have the carrier redirect the parcel within the same country, at no cost.',
        body: [
          'The delivery address of an order can be changed from the order page until the order is ' +
            'dispatched, usually the same working day for orders placed before 2 pm.',
          'Once the order is dispatched, we can no longer change its address. Support can ask the ' +
            'carrier to redirect the parcel to another address in the same country: a redirection ' +
            'takes 1 extra working day and costs nothing.',
          'A parcel cannot be redirected to a parcel locker or abroad. To make a new address the ' +
            'default for future orders, change it under Account settings, Addresses.',
        ].join('\n\n'),
        facts: [
          'changed from the order page until the order is dispatched',
          'redirect the parcel to another address in the same country',
          'a redirection takes 1 extra working day and costs nothing',
          'cannot be redirected to a parcel locker or abroad',
        ],
      },
      caseTemplates: [
        {
          subject: 'Change the delivery address after an office move',
          description:
            'Hello, {firstName} from {company}. We have just moved offices and our last order is ' +
            'going to the old address. Can you change it?',
          priority: 'Medium',
          origin: 'Phone',
          followUp:
            'The order shows as dispatched. Were you able to ask the carrier to redirect it?',
          resolution: [
            'Order already dispatched. Asked the carrier to redirect the parcel to the new office ' +
              'address.',
            'The carrier confirmed the redirection and delivered one working day later. Reminded the ' +
              'customer to change the default address under Account settings. Case closed.',
          ],
        },
        {
          subject: 'Deliver the order to a parcel locker instead',
          description:
            'Hi, this is {firstName} at {company}. Nobody will be at the office this week. Could the ' +
            'parcel go to a parcel locker near us?',
          priority: 'Low',
          origin: 'Web',
          followUp: 'Is there another option if the locker is not possible?',
          resolution: [
            'Explained that a parcel cannot be redirected to a parcel locker. Offered a redirection ' +
              'to another address in the same country.',
            'The customer chose the address of a neighbouring shop; redirection booked at no cost. ' +
              'Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hello, this is {email}. I need my order delivered to a different address.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}", checks whether the order has been ' +
            'dispatched and explains that a dispatched parcel can be redirected to another address ' +
            'in the same country at no cost.',
        },
        {
          text: 'Can you send my parcel to my holiday address in another country instead?',
          expectedOutcome: 'The agent explains that a parcel cannot be redirected abroad.',
        },
      ],
    },
    {
      key: 'warranty',
      label: 'Warranty',
      article: {
        title: 'Warranty on furniture and electronics',
        summary:
          'Furniture and small electronics carry a 2-year warranty from delivery; consumables do ' +
          'not. A faulty item is repaired or replaced free of charge.',
        body: [
          'Office furniture and small electronics sold by us carry a 2-year warranty from the date ' +
            'of delivery. Consumables such as paper, ink and toner are not covered.',
          'To make a claim, open a case with the order number, the serial number of the item when ' +
            'it has one, and a description or a video of the fault.',
          'Support first suggests checks that often solve the problem. If the item is still faulty, ' +
            'it is repaired or replaced free of charge; when neither is possible, the price of the ' +
            'item is refunded.',
          'The warranty does not cover damage from misuse, accidents or wear, such as scratched ' +
            'surfaces.',
        ].join('\n\n'),
        facts: [
          'a 2-year warranty from the date of delivery',
          'Consumables such as paper, ink and toner are not covered',
          'the serial number of the item',
          'repaired or replaced free of charge',
          'does not cover damage from misuse, accidents or wear',
        ],
      },
      caseTemplates: [
        {
          subject: 'Shredder stopped working after eight months',
          description:
            'Hello, {firstName} from {company}. Our paper shredder stopped working after eight ' +
            'months. It turns on but the blades do not move.',
          priority: 'Medium',
          origin: 'Email',
          followUp:
            'We tried the reset you suggested and it still does not work. What happens next?',
          resolution: [
            'Within the 2-year warranty. Asked for the serial number and suggested clearing the ' +
              'blades and resetting the motor.',
            'Still faulty after the checks. Replacement shredder sent free of charge; the carrier ' +
              'collected the faulty one. Case closed.',
          ],
        },
        {
          subject: 'Desk chair keeps sinking',
          description:
            'Hi, {firstName} at {company} here. One of the desk chairs we bought last year keeps ' +
            'sinking when we sit on it.',
          priority: 'Low',
          origin: 'Phone',
          followUp: 'Do you need anything else from us to repair the chair?',
          resolution: [
            'Delivered fourteen months ago, within the 2-year warranty. Asked for the order number ' +
              'and a short video of the fault.',
            'Replacement gas lift shipped free of charge with fitting instructions. The customer ' +
              'confirmed the chair works. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, my address is {email}. Something I bought from you is faulty. Is it under warranty?',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}", explains the 2-year warranty from the ' +
            'date of delivery and asks for the order number, the serial number and a description ' +
            'of the fault.',
        },
        {
          text: 'Our ink cartridges dried out. Can we claim them under the warranty?',
          expectedOutcome:
            'The agent explains that consumables such as paper, ink and toner are not covered by ' +
            'the warranty.',
        },
      ],
    },
  ],
  decoy: {
    title: 'Returns of items sold by marketplace sellers',
    summary:
      'Items sold by marketplace sellers are returned under the policy of their seller, which may ' +
      'differ from ours.',
    body: [
      'Some items on our website are sold and shipped by marketplace sellers: their page says ' +
        '"Sold by" with the name of the seller.',
      'These items are returned under the return policy of the seller, which may give 14 days ' +
        'instead of 30 and may charge for the return shipping.',
      'Start the return from the order page: the request goes to the seller, who answers within 2 ' +
        'working days. If the seller does not answer, our support steps in.',
    ].join('\n\n'),
    resembles: 'refund',
  },
  outOfScope: [
    {
      text: 'Can you recommend a good restaurant near your warehouse?',
      expectedOutcome:
        'The agent says it cannot help with that and offers help with orders, deliveries, refunds ' +
        'and warranties.',
    },
    {
      text: 'What do you think the stock market will do this week?',
      expectedOutcome:
        "The agent declines to give a financial opinion and steers back to the customer's orders.",
    },
  ],
};

/** A broadband provider for small offices. */
export const BROADBAND_SUPPORT_PACK: ScenarioPack = {
  version: 1,
  id: 'broadband-support',
  name: 'Broadband support',
  language: 'en_US',
  businessContext:
    'A broadband provider for small offices: fibre and copper lines, a router supplied with every ' +
    'plan, and plans billed monthly. Customers write to support about outages, speed, bills, ' +
    'their router and changes of plan.',
  customers: { count: 10, industry: 'Consulting' },
  topics: [
    {
      key: 'outage',
      label: 'Service outage',
      article: {
        title: 'When the internet connection is down',
        summary:
          'Check the service status page, then restart the router. Support runs a remote line test ' +
          'and credits each full day without service.',
        body: [
          'First check the service status page in your account, which lists outages by postcode. ' +
            'If an outage is listed, the estimated time of repair is shown there and updated every ' +
            'hour: there is no need to open a case.',
          'If no outage is listed, restart the router by unplugging it for 30 seconds, and check ' +
            'that the light marked Internet turns green within 5 minutes. A red light means the line ' +
            'is not reaching the router.',
          'If the connection is still down, support runs a remote line test, which takes about 10 ' +
            'minutes, and books an engineer visit when the fault is on the line.',
          'When a fault lasts more than 24 hours, a credit for each full day without service is ' +
            'added to the next bill automatically.',
        ].join('\n\n'),
        facts: [
          'service status page',
          'unplugging it for 30 seconds',
          'a remote line test',
          'a credit for each full day without service is added to the next bill',
        ],
      },
      caseTemplates: [
        {
          subject: 'No internet in the office since this morning',
          description:
            'Hello, this is {firstName} from {company}. We have had no internet since 8 this ' +
            'morning, and the Internet light on the router is red.',
          priority: 'High',
          origin: 'Phone',
          followUp: 'Still no connection after the restart. When can an engineer come?',
          resolution: [
            'No outage listed for the postcode. Router restarted with the customer; the Internet ' +
              'light stayed red. The remote line test found a fault on the line.',
            'Engineer visit booked for the next morning; line repaired. Credit for one full day ' +
              'without service added to the next bill. Case closed.',
          ],
        },
        {
          subject: 'Connection drops several times a day',
          description:
            'Hi, {firstName} at {company} here. Our connection drops for a few minutes several ' +
            'times a day, which cuts our video calls.',
          priority: 'Medium',
          origin: 'Email',
          followUp: 'It dropped three more times yesterday. Did the line test show anything?',
          resolution: [
            'The remote line test showed the line losing sync several times a day. Asked the ' +
              'customer to plug the router into the main wall socket without an extension cable.',
            'No drops in the three days after removing the extension cable. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, this is {email}. Our internet is down, can you help?',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}", checks the service status page for an ' +
            'outage and, if none is listed, guides the customer to restart the router by unplugging ' +
            'it for 30 seconds.',
        },
        {
          text: 'We were offline for two whole days last week. Do we get anything back?',
          expectedOutcome:
            'The agent explains that when a fault lasts more than 24 hours, a credit for each full ' +
            'day without service is added to the next bill.',
        },
      ],
    },
    {
      key: 'slow-speed',
      label: 'Slow speed',
      article: {
        title: 'Slower speeds than expected',
        summary:
          'Measure by cable, three times a day, against the minimum guaranteed speed of the plan. ' +
          'A line that cannot reach it can leave its contract without a fee.',
        body: [
          'Each plan has a minimum guaranteed speed, shown in the welcome email and on the plan page ' +
            'of your account. Speeds measured over Wi-Fi are often lower than the speed of the line, ' +
            'so measure with a computer connected to the router by cable.',
          'Run the speed test in your account three times at different times of day. If all three ' +
            'results are below the minimum guaranteed speed, open a case with the results.',
          'Support then checks the line remotely. If the line cannot reach the minimum guaranteed ' +
            'speed within 30 days, the customer can move to a cheaper plan that matches the speed, ' +
            'or leave the contract without an early termination fee.',
        ].join('\n\n'),
        facts: [
          'minimum guaranteed speed',
          'connected to the router by cable',
          'three times at different times of day',
          'leave the contract without an early termination fee',
        ],
      },
      caseTemplates: [
        {
          subject: 'Download speed far below our plan',
          description:
            'Hello, {firstName} from {company}. We pay for 500 Mbps and the speed test shows about ' +
            '60 Mbps.',
          priority: 'Medium',
          origin: 'Web',
          followUp:
            'We ran the test three times by cable as you asked: 58, 61 and 64 Mbps. What now?',
          resolution: [
            'Asked the customer to run the speed test three times at different times of day, with ' +
              'a computer connected by cable.',
            'All three results below the minimum guaranteed speed. Line fault fixed remotely; the ' +
              'speed is back to 480 Mbps. Case closed.',
          ],
        },
        {
          subject: 'Wi-Fi slow in the meeting room',
          description:
            'Hi, this is {firstName} at {company}. The Wi-Fi in our meeting room is very slow, while ' +
            'the desks near the router are fine.',
          priority: 'Low',
          origin: 'Email',
          followUp: 'Is there a way to improve the Wi-Fi without moving the router?',
          resolution: [
            'The speed test by cable at the router matched the plan: the line is fine, and the Wi-Fi ' +
              'does not reach the meeting room.',
            'Suggested a Wi-Fi extender; the customer confirmed the meeting room now gets a good ' +
              'signal. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hello, it is {email}. Our internet is much slower than what we pay for.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and asks the customer to run the speed ' +
            'test three times at different times of day, with a computer connected to the router ' +
            'by cable.',
        },
        {
          text: 'If you can never give us the speed we pay for, can we cancel without a fee?',
          expectedOutcome:
            'The agent explains that when the line cannot reach the minimum guaranteed speed ' +
            'within 30 days, the customer can leave the contract without an early termination fee.',
        },
      ],
    },
    {
      key: 'billing-dispute',
      label: 'Bill dispute',
      article: {
        title: 'Questions about your bill',
        summary:
          'Bills are issued on the 1st of each month. A dispute opened before the direct debit date ' +
          'puts the disputed amount on hold during the review.',
        body: [
          'Bills are issued on the 1st of each month and paid by direct debit 14 days later. The ' +
            'first bill after a change of plan covers part of two months, so it is often higher ' +
            'than usual.',
          'If a bill looks wrong, open a dispute before the direct debit date. The disputed amount ' +
            'is put on hold and is not collected while support reviews it; the rest of the bill is ' +
            'collected as usual.',
          'A review takes up to 10 working days. When the charge was wrong, the amount is refunded ' +
            'or credited to the next bill, as the customer prefers.',
          'One-off charges, such as an engineer visit for a fault on your own equipment, are listed ' +
            'on the bill with the date of the visit.',
        ].join('\n\n'),
        facts: [
          'issued on the 1st of each month',
          'open a dispute before the direct debit date',
          'The disputed amount is put on hold',
          'A review takes up to 10 working days',
        ],
      },
      caseTemplates: [
        {
          subject: 'Bill twice the usual amount',
          description:
            'Hello, {firstName} from {company}. This month the bill is twice what we normally pay, ' +
            'and we have not changed anything.',
          priority: 'High',
          origin: 'Email',
          followUp: 'The direct debit is due next week. Will the disputed part still be taken?',
          resolution: [
            'Dispute opened before the direct debit date; the disputed amount is on hold.',
            'The review found a monthly charge billed twice. Amount credited to the next bill. ' +
              'Case closed.',
          ],
        },
        {
          subject: 'Charge for an engineer visit we did not ask for',
          description:
            'Hi, {firstName} at {company} here. Our bill shows a charge for an engineer visit, and ' +
            'we never booked one.',
          priority: 'Medium',
          origin: 'Phone',
          followUp: 'Could you tell us the date of this visit and who booked it?',
          resolution: [
            'The bill shows the date of the visit, which had been booked against this account by ' +
              'mistake.',
            'Charge removed and refunded. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'This is {email}. Our latest bill is wrong, what can we do?',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and explains that a dispute opened before ' +
            'the direct debit date puts the disputed amount on hold while support reviews it.',
        },
        {
          text: 'How long does it take to sort out a billing dispute?',
          expectedOutcome: 'The agent says a review takes up to 10 working days.',
        },
      ],
    },
    {
      key: 'router',
      label: 'Router',
      article: {
        title: 'Your router: setup, reset and replacement',
        summary:
          'The Wi-Fi details are on the card at the back of the router. A factory reset brings ' +
          'them back, and a faulty router is replaced free of charge.',
        body: [
          'Every plan comes with a router, which stays our property. The Wi-Fi name and password ' +
            'are printed on the card at the back of the router.',
          'A factory reset puts back the original Wi-Fi name and password: hold the reset button ' +
            'for 15 seconds with a pin while the router is on. Any settings you changed, such as ' +
            'port forwarding, are lost.',
          'A faulty router is replaced free of charge, delivered within 2 working days. Return the ' +
            'old one in the same box with the prepaid label: a router not returned within 30 days is ' +
            'charged at its replacement price.',
        ].join('\n\n'),
        facts: [
          'printed on the card at the back of the router',
          'hold the reset button for 15 seconds',
          'replaced free of charge, delivered within 2 working days',
          'not returned within 30 days is charged',
        ],
      },
      caseTemplates: [
        {
          subject: 'Router keeps restarting on its own',
          description:
            'Hello, this is {firstName} from {company}. Our router restarts by itself every hour or ' +
            'so, even after a factory reset.',
          priority: 'Medium',
          origin: 'Web',
          followUp: 'Has the replacement router been sent? We have no tracking number yet.',
          resolution: [
            'The factory reset did not help, and remote diagnostics show the router overheating. ' +
              'Replacement router ordered free of charge.',
            'Replacement delivered in 2 working days; the old router returned with the prepaid ' +
              'label. Case closed.',
          ],
        },
        {
          subject: 'Wi-Fi password lost after changing it',
          description:
            'Hi, {firstName} at {company}. We changed the Wi-Fi password and nobody wrote it down. ' +
            'How do we get back in?',
          priority: 'Low',
          origin: 'Phone',
          followUp: 'We did the reset, but the password on the card does not work either.',
          resolution: [
            'Guided the customer through a factory reset, holding the reset button for 15 seconds ' +
              'with a pin.',
            'The router is back to the Wi-Fi name and password printed on the card at the back. ' +
              'The customer is connected. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, it is {email}. Our router seems to be broken.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and explains that a faulty router is ' +
            'replaced free of charge, delivered within 2 working days.',
        },
        {
          text: 'Where do I find the Wi-Fi password?',
          expectedOutcome:
            'The agent says the Wi-Fi name and password are printed on the card at the back of ' +
            'the router.',
        },
      ],
    },
    {
      key: 'plan-change',
      label: 'Change of plan',
      article: {
        title: 'Changing your plan',
        summary:
          'A faster plan can be taken at any time and is active within 24 hours. A cheaper one is ' +
          'possible after the first 12 months of the contract.',
        body: [
          'You can move to a faster plan at any time, and the new speed is active within 24 hours, ' +
            'without a new contract period.',
          'Moving to a slower or cheaper plan is possible once the first 12 months of the contract ' +
            'have passed, and takes effect on the next billing date.',
          'The first bill after a change covers part of two months, each at its own price. Leaving ' +
            'before the end of the contract costs an early termination fee equal to the remaining ' +
            'monthly charges, unless the line cannot reach its minimum guaranteed speed.',
        ].join('\n\n'),
        facts: [
          'move to a faster plan at any time',
          'active within 24 hours',
          'once the first 12 months of the contract have passed',
          'an early termination fee equal to the remaining monthly charges',
        ],
      },
      caseTemplates: [
        {
          subject: 'Upgrade to the fastest plan',
          description:
            'Hello, {firstName} from {company}. We have hired more people and want the faster plan ' +
            'as soon as possible.',
          priority: 'Low',
          origin: 'Web',
          followUp:
            'We placed the upgrade yesterday but the speed is the same. When will it change?',
          resolution: [
            'Upgrade placed; explained that it is active within 24 hours and starts no new contract ' +
              'period.',
            'The speed test the next day confirmed the new plan. Case closed.',
          ],
        },
        {
          subject: 'Move to a cheaper plan',
          description:
            'Hi, {firstName} at {company} here. There are fewer of us in the office now and we would ' +
            'like a cheaper plan.',
          priority: 'Medium',
          origin: 'Email',
          followUp: 'Can you confirm from which bill the cheaper plan applies?',
          resolution: [
            'The contract started fifteen months ago, past its first 12 months: the move is allowed.',
            'Cheaper plan booked from the next billing date. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, this is {email}. We want to change our plan.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and explains that a faster plan is active ' +
            'within 24 hours, while a cheaper plan is possible once the first 12 months of the ' +
            'contract have passed.',
        },
        {
          text: 'What does it cost to leave our contract early?',
          expectedOutcome:
            'The agent explains that the early termination fee equals the remaining monthly ' +
            'charges, unless the line cannot reach its minimum guaranteed speed.',
        },
      ],
    },
  ],
  decoy: {
    title: 'Planned maintenance windows',
    summary:
      'Planned maintenance is announced a week ahead and done at night. It is not a fault, and ' +
      'gives no credit.',
    body: [
      'Planned maintenance is announced at least 7 days ahead, by email and on the service status ' +
        'page.',
      'The work is done between midnight and 6 am, and the connection may drop for up to 30 minutes ' +
        'during that window.',
      'Planned maintenance is not a fault: no credit is added to the bill for it, and no case needs ' +
        'to be opened.',
    ].join('\n\n'),
    resembles: 'outage',
  },
  outOfScope: [
    {
      text: 'Can you help me choose a new laptop for the office?',
      expectedOutcome:
        'The agent says it cannot advise on computers and offers help with the connection, bills, ' +
        'the router or the plan.',
    },
    {
      text: 'Who is going to win the football match tonight?',
      expectedOutcome: "The agent declines and steers back to the customer's broadband service.",
    },
  ],
};

/** A project management application sold as a subscription. */
export const SAAS_SUPPORT_PACK: ScenarioPack = {
  version: 1,
  id: 'saas-support',
  name: 'SaaS support',
  language: 'en_US',
  businessContext:
    'A project management application sold to companies as a subscription billed per user. ' +
    'Administrators manage single sign-on and users, and everyone can export data and use the ' +
    'API. Customers write to support about sign-in, passwords, invoices, exports and API errors.',
  customers: { count: 10, industry: 'Technology' },
  topics: [
    {
      key: 'sso',
      label: 'Single sign-on',
      article: {
        title: 'Setting up and fixing single sign-on',
        summary:
          'Single sign-on uses SAML 2.0 on the Business and Enterprise plans. Most errors come from ' +
          'an entity ID that does not match, or a certificate that expired.',
        body: [
          'Single sign-on uses SAML 2.0 and is available on the Business and Enterprise plans. An ' +
            'administrator sets it up under Admin, Security, Single sign-on, by uploading the ' +
            'metadata file of the identity provider.',
          'The most common error, Invalid audience, means the entity ID configured in the identity ' +
            'provider does not match the one shown on the Single sign-on page: copy it again exactly.',
          'While single sign-on is being set up, keep the test mode on: only administrators sign in ' +
            'through the identity provider, and everyone else keeps their password. Turning on ' +
            'enforcement signs out every user who is not an administrator.',
          'If the certificate of the identity provider expires, nobody can sign in through it: ' +
            'upload the new certificate before the old one expires.',
        ].join('\n\n'),
        facts: [
          'available on the Business and Enterprise plans',
          'the entity ID configured in the identity provider does not match',
          'keep the test mode on',
          'upload the new certificate before the old one expires',
        ],
      },
      caseTemplates: [
        {
          subject: 'Invalid audience error when signing in with single sign-on',
          description:
            'Hello, {firstName} from {company}. We are setting up single sign-on, and every test ' +
            'sign-in fails with Invalid audience.',
          priority: 'High',
          origin: 'Email',
          followUp: 'We copied the entity ID again and still see the error. Could you check?',
          resolution: [
            'The entity ID in the identity provider ended with a slash that the Single sign-on page ' +
              'does not have.',
            'The customer removed the slash and the test sign-in works. Advised to keep the test ' +
              'mode on until every user has been checked. Case closed.',
          ],
        },
        {
          subject: 'Nobody can sign in since this morning',
          description:
            'Hi, this is {firstName} at {company}. Since this morning none of our users can sign in ' +
            'through single sign-on.',
          priority: 'High',
          origin: 'Phone',
          followUp: 'Our administrator can sign in with a password. What should we change?',
          resolution: [
            'The sign-in logs show that the certificate of the identity provider expired overnight.',
            'The administrator uploaded the new certificate and users can sign in again. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, I am {email}. Our single sign-on setup fails with an Invalid audience error.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and explains that the entity ID ' +
            'configured in the identity provider must match the one shown on the Single sign-on ' +
            'page.',
        },
        {
          text: 'We are on the Starter plan. Can we use single sign-on?',
          expectedOutcome:
            'The agent explains that single sign-on is available on the Business and Enterprise ' +
            'plans only.',
        },
      ],
    },
    {
      key: 'password',
      label: 'Password reset',
      article: {
        title: 'Resetting a password',
        summary:
          'A reset link is valid for 60 minutes. Five failed sign-ins lock the account for 15 ' +
          'minutes, and with single sign-on the identity provider manages passwords.',
        body: [
          'Use Forgot password on the sign-in page: a reset link is emailed to the address of the ' +
            'account and stays valid for 60 minutes. Only the latest link works.',
          'After 5 failed sign-in attempts, the account is locked for 15 minutes, then unlocks by ' +
            'itself. An administrator can unlock it sooner from Admin, Users.',
          'When single sign-on is enforced, passwords are managed by the identity provider and ' +
            'Forgot password does not apply: ask the IT team of your company.',
          'If the reset email does not arrive, check the spam folder, then ask an administrator to ' +
            'confirm the address of the account.',
        ].join('\n\n'),
        facts: [
          'stays valid for 60 minutes',
          'After 5 failed sign-in attempts, the account is locked for 15 minutes',
          'An administrator can unlock it sooner',
          'passwords are managed by the identity provider',
        ],
      },
      caseTemplates: [
        {
          subject: 'Password reset email never arrives',
          description:
            'Hello, {firstName} from {company}. I asked for a password reset three times and no ' +
            'email has arrived.',
          priority: 'Medium',
          origin: 'Web',
          followUp: 'Nothing in the spam folder either. Could you check the address of my account?',
          resolution: [
            'The address of the account had a typing mistake, which the administrator of the ' +
              'customer corrected under Admin, Users.',
            'A new reset link arrived and was used within 60 minutes. Case closed.',
          ],
        },
        {
          subject: 'Account locked after failed sign-ins',
          description:
            'Hi, {firstName} at {company}. I mistyped my password a few times and now my account is ' +
            'locked.',
          priority: 'Low',
          origin: 'Email',
          followUp: 'It is still locked. Can someone unlock it now? I have a deadline.',
          resolution: [
            'Explained that the account is locked for 15 minutes after 5 failed attempts.',
            'The administrator of the customer unlocked it from Admin, Users. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'This is {email}. I cannot reset my password, the link does not work.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and explains that a reset link stays ' +
            'valid for 60 minutes and only the latest one works.',
        },
        {
          text: 'My account is locked. How long do I have to wait?',
          expectedOutcome:
            'The agent explains that after 5 failed sign-in attempts the account is locked for 15 ' +
            'minutes, and that an administrator can unlock it sooner.',
        },
      ],
    },
    {
      key: 'invoice',
      label: 'Invoice',
      article: {
        title: 'Invoices and billing',
        summary:
          'Invoices are under Admin, Billing, for billing administrators. Users are billed pro rata ' +
          'from the day they are added and until the end of the period when removed.',
        body: [
          'Invoices are issued on the first day of each billing period and are available under ' +
            'Admin, Billing, Invoices, as PDF files. Only billing administrators can see them.',
          'Each user active during the period is billed. Users added during the period are billed ' +
            'pro rata from the day they were added; users removed are billed until the end of the ' +
            'period.',
          'To change the company name, address or tax number on future invoices, change them under ' +
            'Admin, Billing, Details. An invoice already issued can be reissued with the new details ' +
            'on request, within 90 days of its date.',
        ].join('\n\n'),
        facts: [
          'Only billing administrators can see them',
          'billed pro rata from the day they were added',
          'users removed are billed until the end of the period',
          'reissued with the new details on request, within 90 days',
        ],
      },
      caseTemplates: [
        {
          subject: 'Invoice shows more users than we have',
          description:
            'Hello, {firstName} from {company}. Our latest invoice bills 48 users, and we only have ' +
            '40 today.',
          priority: 'Medium',
          origin: 'Email',
          followUp: 'We removed 8 users last month. Why are they still on the invoice?',
          resolution: [
            'The 8 users were removed during the billing period: explained that they are billed ' +
              'until the end of the period.',
            'Next invoice checked with the customer: 40 users. Case closed.',
          ],
        },
        {
          subject: 'New tax number needed on our last invoice',
          description:
            'Hi, this is {firstName} at {company}. Our tax number changed. Can our last invoice ' +
            'show the new one?',
          priority: 'Low',
          origin: 'Web',
          followUp: 'Has the reissued invoice been sent? Our accountant needs it this week.',
          resolution: [
            'Invoice dated twenty days ago, within 90 days: reissue accepted. Asked the customer to ' +
              'change the tax number under Admin, Billing, Details.',
            'Invoice reissued with the new tax number. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, it is {email}. Our invoice looks wrong.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and explains how users are billed: pro ' +
            'rata from the day they were added, and until the end of the period when removed.',
        },
        {
          text: 'Where can I download our invoices?',
          expectedOutcome:
            'The agent says invoices are under Admin, Billing, Invoices, and that only billing ' +
            'administrators can see them.',
        },
      ],
    },
    {
      key: 'data-export',
      label: 'Data export',
      article: {
        title: 'Exporting your data',
        summary:
          'An administrator exports everything as a ZIP file of CSV files, once every 24 hours. The ' +
          'download link is valid for 7 days.',
        body: [
          'Administrators can export all the data of their company under Admin, Data, Export. The ' +
            'export is a ZIP file of CSV files, one per type of record, with the attachments in a ' +
            'separate folder.',
          'An export is prepared in the background, and a download link is emailed when it is ' +
            'ready, within 2 hours for most companies. The link stays valid for 7 days.',
          'One full export can be started every 24 hours. A single project can be exported to CSV ' +
            'at any time from its own menu, by anyone who can see the project.',
          'When a subscription ends, data stays available for export for 30 days, then it is ' +
            'deleted.',
        ].join('\n\n'),
        facts: [
          'a ZIP file of CSV files',
          'The link stays valid for 7 days',
          'One full export can be started every 24 hours',
          'data stays available for export for 30 days',
        ],
      },
      caseTemplates: [
        {
          subject: 'Export download link has expired',
          description:
            'Hello, {firstName} from {company}. The link in the export email says it has expired, ' +
            'and we need the export for an audit.',
          priority: 'Medium',
          origin: 'Email',
          followUp:
            'We tried to start a new export, but it says we have to wait. When can we retry?',
          resolution: [
            'The link was nine days old, and links stay valid for 7 days. A new export had been ' +
              'started earlier the same day.',
            'New export started the next day; the link arrived within the hour. Case closed.',
          ],
        },
        {
          subject: 'Export is missing the attachments',
          description:
            'Hi, {firstName} at {company} here. Our export has the CSV files, but we cannot find ' +
            'any of the attachments.',
          priority: 'Low',
          origin: 'Web',
          followUp:
            'We looked again and still cannot see the attachments in the ZIP. Where are they?',
          resolution: [
            'The attachments are in a separate folder of the ZIP file, and the tool of the customer ' +
              'showed only the top folder.',
            'The customer found the attachments after extracting the whole ZIP. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hello, this is {email}. I need a full export of our data.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}" and explains that an administrator ' +
            'starts the export under Admin, Data, Export, and that the download link is emailed ' +
            'and stays valid for 7 days.',
        },
        {
          text: 'We are cancelling our subscription. How long can we still get our data?',
          expectedOutcome:
            'The agent explains that data stays available for export for 30 days after the ' +
            'subscription ends, then it is deleted.',
        },
      ],
    },
    {
      key: 'api-error',
      label: 'API error',
      article: {
        title: 'Common API errors',
        summary:
          'Error 401 is a token problem, 429 the limit of 100 requests a minute, 500 an error on ' +
          'our side. A token is shown only once.',
        body: [
          'API requests are authenticated with a token created under Settings, API tokens. A token ' +
            'is shown only once, when it is created: a lost token cannot be recovered and must be ' +
            'replaced.',
          'Error 401 means the token is missing, wrong or revoked. Error 403 means the token is ' +
            'valid, but its user cannot see the record or the project.',
          'Error 429 means the rate limit was reached: each token can make 100 requests per ' +
            'minute. Wait for the number of seconds given in the Retry-After header before sending ' +
            'again.',
          'Error 500 is an error on our side. It is logged automatically, and retrying after a ' +
            'short wait usually works. Include the request ID of the response when you open a case.',
        ].join('\n\n'),
        facts: [
          'A token is shown only once',
          'Error 401 means the token is missing, wrong or revoked',
          '100 requests per minute',
          'the Retry-After header',
          'Include the request ID',
        ],
      },
      caseTemplates: [
        {
          subject: 'API returns error 429 during our nightly sync',
          description:
            'Hello, {firstName} from {company}. Our nightly sync started failing with error 429 ' +
            'after we added more projects.',
          priority: 'High',
          origin: 'Email',
          followUp:
            'We added a pause between requests but still see some 429 errors. What limit should we ' +
            'stay under?',
          resolution: [
            'The logs show the sync sending about 300 requests per minute with one token, above the ' +
              'limit of 100 requests per minute.',
            'The customer now waits as long as the Retry-After header says, and the nightly sync ' +
              'completes. Case closed.',
          ],
        },
        {
          subject: 'API token stopped working with error 401',
          description:
            'Hi, this is {firstName} at {company}. Our integration gets error 401 since yesterday, ' +
            'with no change on our side.',
          priority: 'Medium',
          origin: 'Web',
          followUp:
            'Can we see the old token again, so that we do not have to change every server?',
          resolution: [
            'The token had been revoked by an administrator during a security review.',
            'Explained that a token is shown only once; the customer created a new token and ' +
              'updated the integration. Case closed.',
          ],
        },
      ],
      utterances: [
        {
          text: 'Hi, I am {email}. Our API calls keep failing with error 429.',
          expectedOutcome:
            'The agent finds the open case "{caseSubject}", explains the limit of 100 requests per ' +
            'minute for each token, and says to wait for the number of seconds given in the ' +
            'Retry-After header.',
        },
        {
          text: 'I lost our API token. Can you send it to me again?',
          expectedOutcome:
            'The agent explains that a token is shown only once and cannot be recovered, so a new ' +
            'one is created under Settings, API tokens.',
        },
      ],
    },
  ],
  decoy: {
    title: 'Two-factor authentication',
    summary:
      'Two-factor authentication adds a code from an authenticator app to a password sign-in. It ' +
      'does not apply to single sign-on.',
    body: [
      'Two-factor authentication adds a code from an authenticator app to the password at sign-in. ' +
        'Each user turns it on under Profile, Security, and an administrator can require it for ' +
        'everyone under Admin, Security, Two-factor.',
      'A user who loses their phone signs in with one of the 10 backup codes shown when they turned ' +
        'it on.',
      'Two-factor authentication applies to password sign-ins only: users who sign in through ' +
        'single sign-on follow the rules of their identity provider.',
    ].join('\n\n'),
    resembles: 'sso',
  },
  outOfScope: [
    {
      text: 'Can you write the code for our company website?',
      expectedOutcome:
        'The agent says it cannot build websites and offers help with sign-in, invoices, data ' +
        'exports or the API.',
    },
    {
      text: 'What will the weather be like tomorrow?',
      expectedOutcome: "The agent declines and steers back to the customer's account.",
    },
  ],
};

/**
 * The packs SandForge ships, in the order they are offered: the one whose
 * subjects every reader knows first.
 */
export const BUILT_IN_SCENARIO_PACKS: readonly ScenarioPack[] = [
  RETAIL_ORDERS_PACK,
  BROADBAND_SUPPORT_PACK,
  SAAS_SUPPORT_PACK,
];
