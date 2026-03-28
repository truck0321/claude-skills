---
name: mealie
description: Look up today's meal plan from Mealie. Use when user asks about meals, dinner, what's for dinner, meal plan, or when generating a morning briefing.
---

# Mealie Meal Plan Lookup

Fetch today's meal plan from the Mealie instance.

## How to fetch

Run this curl command to get today's meals:

```bash
curl -s "${MEALIE_URL}/api/households/mealplans?start_date=$(date +%Y-%m-%d)&end_date=$(date +%Y-%m-%d)" \
  -H "Authorization: Bearer ${MEALIE_API_KEY}"
```

Environment variables `MEALIE_URL` and `MEALIE_API_KEY` are set in the project .env file.

## Response format

The API returns `{ items: [...] }` where each item has:
- `date`: the date
- `entryType`: "dinner", "lunch", "breakfast", etc.
- `recipe.name`: the recipe name
- `recipe.description`: short description
- `recipe.totalTime`: total cook time
- `recipe.prepTime`: prep time
- `recipe.recipeServings`: number of servings
- `recipe.slug`: can build a link as `${MEALIE_URL}/g/home/r/{slug}`

## Output format

Keep it brief:
- For morning briefing: "Dinner tonight: [Recipe Name] (~[totalTime])"
- If asked for more detail: include description, servings, prep time, and a link
- If no meals planned: "No meals on the plan for today"

## Fetching a week's meals

To get the full week (Mon-Fri):
```bash
# Calculate Monday of current week
start=$(date -d "last monday" +%Y-%m-%d 2>/dev/null || date -v-mon +%Y-%m-%d)
end=$(date -d "$start + 4 days" +%Y-%m-%d 2>/dev/null || date -v+4d -j -f %Y-%m-%d $start +%Y-%m-%d)
curl -s "${MEALIE_URL}/api/households/mealplans?start_date=$start&end_date=$end" \
  -H "Authorization: Bearer ${MEALIE_API_KEY}"
```
