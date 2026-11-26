import { useRef } from 'react';
import { View, type TextInputInstance } from 'react-native';
import { TextField } from '@/components/ui/TextField';

// "Where You Had It": the VENUE of a check-in (where you had it), always
// visible, never folded (Simon: "more prominent", the place is half the memory
// of a check-in), and its city. Distinct from the bottle's ORIGIN (the
// catalogue's). The feed renders it as "venue, city". Sent as `venueName` /
// `city`, each only when not empty. Check In's details, the check-in edit's
// details and Had It Too (extracted at its third use).
export function WhereYouHadIt({ venue, city, onVenue, onCity, editable }: {
  venue: string;
  city: string;
  onVenue: (v: string) => void;
  onCity: (v: string) => void;
  // false: read-only (Had It Too once its post may have landed).
  editable?: boolean;
}) {
  const cityRef = useRef<TextInputInstance>(null);
  return (
    <View style={{ flexDirection: 'row', gap: 12, marginBottom: 4 }}>
      <View style={{ flex: 1.4 }}>
        <TextField label="Where You Had It" placeholder="Bar, restaurant, home…" value={venue} onChangeText={onVenue} editable={editable} returnKeyType="next" submitBehavior="submit" onSubmitEditing={() => cityRef.current?.focus()} />
      </View>
      <View style={{ flex: 1 }}>
        <TextField ref={cityRef} label="City" placeholder="City" value={city} onChangeText={onCity} editable={editable} returnKeyType="done" />
      </View>
    </View>
  );
}
