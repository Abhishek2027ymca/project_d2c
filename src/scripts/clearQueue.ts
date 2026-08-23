/**
 * Drains the ticket queue, including retained completed/failed jobs.
 *
 * Needed because `db:seed` truncates with RESTART IDENTITY: run ids go back to
 * 1 while Redis still holds finished jobs keyed `run-1`, `run-2`, ... Those
 * corpses take the jobIds the next runs want. Resetting the database without
 * resetting the queue leaves two halves of one system disagreeing.
 *
 * Run with:  npm run queue:clear
 */
import { ticketQueue } from '../queue/ticketQueue.js';

const before = await ticketQueue.getJobCounts();
console.log('before:', before);

// obliterate() removes every job in every state, plus the queue's own keys.
// force: true so it does not refuse while a worker holds a lock.
await ticketQueue.obliterate({ force: true });

const after = await ticketQueue.getJobCounts();
console.log('after: ', after);
console.log('\n✓ Queue cleared');

await ticketQueue.close();
