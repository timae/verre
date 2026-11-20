// Compile-time pin (catalogue model change step 4, build plan "tx-required
// compile check"): the three mint helpers REQUIRE a transaction, so every user
// mint can carry its review item (and, in phase 4, its journal event) in the
// same transaction. If `tx` ever became optional, these `@ts-expect-error`
// lines would stop erroring and the root `tsc` would fail on the unused
// directives. Never executed.
import { createProducer, createProduct, createVintage } from '../../lib/catalogWrite'

export function txRequired(): void {
  // @ts-expect-error a producer mint without a transaction
  void createProducer({ name: 'x' }, null)
  // @ts-expect-error a product mint without a transaction
  void createProduct({ name: 'x', producerId: 'p' }, null, [])
  // @ts-expect-error a vintage mint without a transaction
  void createVintage('p', 2020, null, null)
}
