# ATM tie closeout

The entry selector still finds the nearest strike first. When SPY is exactly
between two strikes, it picks the higher strike for a CALL and the lower
strike for a PUT. That chosen contract must have an OPRA spread of at most
`$0.02`.

If that ATM quote fails, the selector checks exactly one next strike in the
breakout direction. The fallback may have a spread up to `$0.05`; if it also
fails, the breakout is abandoned. No farther strike is searched.

All existing entry mechanics remain in place: BUY 3, ask-first pricing with a
frozen midpoint plus `$0.03` cap, 500 ms price-driven reevaluation, the fixed
2-second no-fill timer, and the 5-second window for remaining quantity after
the first fill.

ELI5: if the stock is halfway between two shelves, CALL takes the shelf above
and PUT takes the shelf below. We check that shelf's price first, then one
nearby shelf in the same direction if needed, and stop there.
