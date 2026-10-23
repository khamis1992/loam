"""Discount rules for the pricing service."""


def apply_discount(price: float, rate: float) -> float:
    """Return the price after `rate` (a fraction) is taken off."""
    if rate < 0 or rate > 1:
        raise ValueError("rate must be between 0 and 1")
    return round(price * (1 - rate), 2)
