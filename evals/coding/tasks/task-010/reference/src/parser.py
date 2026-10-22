"""Parse `key=value` strings from the query layer."""


def parse_pairs(text: str) -> dict:
    """Turn "a=1;b=2" into {"a": "1", "b": "2"}, skipping malformed entries."""
    return {
        key.strip(): value.strip()
        for key, _, value in (part.partition("=") for part in text.split(";"))
        if _
    }
