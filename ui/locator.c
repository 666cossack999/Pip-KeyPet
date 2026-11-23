#include "locator.h"

void pip_locator_start(pip_locator_t *locator)
{
    locator->remaining = PIP_LOCATE_DURATION_S;
    locator->next_chirp = PIP_LOCATE_REPEAT_S;
}

void pip_locator_stop(pip_locator_t *locator)
{
    locator->remaining = 0;
    locator->next_chirp = 0;
}

bool pip_locator_active(const pip_locator_t *locator)
{
    return locator->remaining > 0;
}

bool pip_locator_step(pip_locator_t *locator, float dt)
{
    if (!pip_locator_active(locator) || dt <= 0) return false;
    if (dt >= locator->remaining) {
        pip_locator_stop(locator);
        return false;
    }
    locator->remaining -= dt;
    locator->next_chirp -= dt;
    if (locator->next_chirp <= 0) {
        locator->next_chirp += PIP_LOCATE_REPEAT_S;
        if (locator->next_chirp <= 0) locator->next_chirp = PIP_LOCATE_REPEAT_S;
        return true;
    }
    return false;
}
