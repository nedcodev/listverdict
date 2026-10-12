# Listverdict

A free tool for Etsy sellers: check a listing, test a change, and get a fair keep-or-undo verdict that compares the listing with the rest of the shop.

Live site: https://listverdict.com

## How it's built

Plain HTML, CSS and JavaScript. There's no server and nothing to install.

| File | What it is |
| --- | --- |
| `index.html` | The page: hero, email box, the three tools, and the "how it stays fair" section |
| `style.css` | All styling. Colours and fonts are set once at the top in `:root` |
| `script.js` | The tools, the verdict maths and the email signup |
| `privacy.html` | The privacy page |
| `favicon.svg` | The browser tab icon |

Visitors' tests are saved in their own browser (localStorage). Nothing about their listings is sent anywhere.

## Settings

Open `script.js` and edit the `CONFIG` block at the top:

- `kitFormAction`: the address from your Kit form's HTML embed code, the part inside `action="..."`. It looks like `https://app.kit.com/forms/1234567/subscriptions`.
- `kitConsentField`: the Kit custom field that records the "email me tips and updates" box. Create a custom field called `updates_consent` in Kit. Only email people whose value is `yes`.
- `kofiUrl`: your Ko-fi page. Leave it empty to hide the "buy me a coffee" line.

The verdict rules (5 points to keep or undo, 50 views minimum, 14 days) are in the `RULES` block just below.

## How the verdict works

1. The seller enters the listing's views and the whole shop's views for the 14 days before the change.
2. After the test, they enter the same two numbers for the days since the change.
3. Both periods are turned into views per day, so an early check is still fair.
4. The listing's change is compared with the change in the rest of the shop (the shop minus this listing).
5. The difference, in percentage points, decides the verdict: keep at +5 or more, undo at −5 or less, too close to call in between. Fewer than 50 listing views before the change means not enough data.
