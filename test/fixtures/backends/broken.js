// A backend module that loads far enough to fail: the registry must report it
// as `state: 'broken'` with this message as the detail, not as absent.
throw new Error('fixture backend failed to load')
