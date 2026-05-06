from difflib import get_close_matches


def resolve_asset(assets, label_guess: str | None):
    """Return the best-matching Asset from a list or None."""
    if not label_guess or not assets:
        return None
    g = label_guess.strip().lower()
    for a in assets:
        if a.label_name.strip().lower() == g:
            return a
    names = [a.label_name for a in assets]
    close = get_close_matches(label_guess.strip(), names, n=1, cutoff=0.35)
    if close:
        target = close[0]
        for a in assets:
            if a.label_name == target:
                return a
    for a in assets:
        ln = a.label_name.lower()
        if g in ln or ln in g:
            return a
    return None
