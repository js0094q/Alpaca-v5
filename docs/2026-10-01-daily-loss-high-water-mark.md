# Daily realized-loss limit

At `DAY_START`, PAPER freezes the strategy capital used for that trading date.
The daily loss budget is 10% of that amount ($50 with the current $500 PAPER
capital). It does not grow when the account earns a profit during the day.

The bot tracks cumulative realized P&L and its highest value for the date,
starting from zero. New entries are blocked when cumulative realized P&L is at
least one daily budget below that high-water mark. The block remains active
through the rest of the date and is restored after a same-day restart. Existing
positions continue to be managed and sold. The next trading date starts a new
measurement period.

If legacy same-day continuity state has completed buys but no saved realized
high-water mark, the bot blocks new entries for that date rather than guessing
the missing value.
