# ATM tie selection

The entry selector first looks for the nearest strike. If SPY is exactly
between two strikes, CALL selects the higher strike and PUT selects the lower
strike. The selected ATM contract must have an OPRA spread of at most `$0.02`.

If that quote fails, the selector checks exactly one next strike in the
breakout direction. That fallback may have a spread up to `$0.05`. If it also
fails, the breakout is abandoned; no farther strike is searched.
