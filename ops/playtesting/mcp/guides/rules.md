# Magic Comprehensive Rules

Get the current document from the [official Wizards rules page](https://magic.wizards.com/en/rules). [Download the official full text verified for this guide](https://media.wizards.com/2026/downloads/MagicCompRules%2020261106.txt), effective November 6, 2026. Search the TXT for the rule number or keyword. Use the Wizards rules page for newer releases.

| Question | Where to look |
| --- | --- |
| How many cards do I start with, and how do I mulligan? | 103 |
| Who acts, and what happens after everyone passes? | 117 |
| What can I target, and when? | 115, 601, 608 |
| Where does a spell go while it waits to resolve? | 405 |
| When do I move on to the next phase or step? | 500–514 |
| How do attackers, blockers, and combat damage work? | 508–510 |
| When are triggers put on the stack? Which mana abilities bypass it? | 603, 605 |
| What happens if a target becomes illegal? | 608 |
| Is this a continuous effect, replacement, or prevention? | 611–616 |
| What does this keyword do? | 701 for keyword actions, 702 for keyword abilities |
| When do lethal damage and zero toughness remove creatures? | 704 |
| Can I propose a shortcut through priority windows? | 733 |

When everyone passes in succession, the top item resolves if the stack is occupied. An empty stack lets the game move to the next step or phase. Turn ownership and priority can differ. In combat, attackers and blockers are declared in their own steps before the corresponding priority windows. Check the exact steps rather than assuming a main phase follows the next pass.

Use `get_card` for the relevant card and `get_game_state` for the legal choices offered by the deployed XMage build. Use the rule numbers and published card text to explain public game outcomes.
