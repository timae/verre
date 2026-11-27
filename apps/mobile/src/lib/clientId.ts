import { uuid } from 'expo';
import { clientIdFromUuids } from './clientIdFormat';

// A fresh 21-character client id (clientIdFormat.ts) from the native UUID
// generator expo-modules-core ships (iOS: Foundation's UUID, the system's
// secure random source). Minted ONCE per add screen or check-in flow, so a
// retry re-sends the same id and the server answers it instead of adding a
// second bottle (catalogue model change § 8a).
export const newClientId = (): string => clientIdFromUuids(uuid.v4(), uuid.v4());
