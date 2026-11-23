#pragma once
#include <stdbool.h>

/* Pure, platform-independent timer for "Find my Pip".
 * Does not retain state in NVS and has no background FreeRTOS tasks. */
#define PIP_LOCATE_DURATION_S 12.0f
#define PIP_LOCATE_REPEAT_S 2.8f

typedef struct {
    float remaining;
    float next_chirp;
} pip_locator_t;

void pip_locator_start(pip_locator_t *locator);
void pip_locator_stop(pip_locator_t *locator);
bool pip_locator_active(const pip_locator_t *locator);
/* Advance active time; true means the caller should play another chirp. */
bool pip_locator_step(pip_locator_t *locator, float dt);
