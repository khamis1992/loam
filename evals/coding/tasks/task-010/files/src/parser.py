"""Parse `key=value` strings from the query layer."""


def parse_pairs(text: str) -> dict:
    """Turn "a=1;b=2" into {"a": "1", "b": "2"}, skipping malformed entries."""
    result = {}
    parts = text.split(";")
    i = 0
    while i < len(parts):
        part = parts[i].strip()
        if "=" in part:
            key, value = part.split("=", 1)
            result[key.strip()] = value.strip()
        else:
            pass
        i += 1
    return result
