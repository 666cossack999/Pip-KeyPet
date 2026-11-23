/* Standalone behavior checks: no LVGL, ESP-IDF or real device required. */
#include "locator.h"
#include <assert.h>
#include <stdio.h>

int main(void)
{
    pip_locator_t locator = {0};
    assert(!pip_locator_active(&locator));
    assert(!pip_locator_step(&locator, 1));
    pip_locator_start(&locator);
    assert(pip_locator_active(&locator));
    int chirps = 1; /* initial alarm is played immediately by pip_locate() */
    for (int i = 0; i < 130; i++) {
        if (pip_locator_step(&locator, 0.1f)) chirps++;
    }
    assert(chirps == 5); /* immediate + four repeats, automatically stopped */
    assert(!pip_locator_active(&locator));
    assert(!pip_locator_step(&locator, 1));

    pip_locator_start(&locator);
    assert(!pip_locator_step(&locator, 1));
    pip_locator_stop(&locator);
    assert(!pip_locator_active(&locator));
    assert(!pip_locator_step(&locator, 10));

    pip_locator_start(&locator);
    assert(!pip_locator_step(&locator, 2.0f));
    pip_locator_start(&locator); /* another command restarts the 12-second window */
    assert(!pip_locator_step(&locator, 2.0f));
    assert(pip_locator_step(&locator, 1.0f));
    assert(!pip_locator_step(&locator, -1.0f));
    pip_locator_stop(&locator);

    puts("ok: locator start/repeat/auto-stop/manual-stop/restart");
    return 0;
}
