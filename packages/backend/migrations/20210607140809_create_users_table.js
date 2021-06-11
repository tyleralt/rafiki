exports.up = function (knex) {
  return knex.schema.createTable('users', function (table) {
    table.uuid('id').notNullable().primary()
    table.uuid('accountId').notNullable().unique()
    table.timestamp('createdAt').defaultTo(knex.fn.now())
    table.timestamp('updatedAt').defaultTo(knex.fn.now())
  })
}

exports.down = function (knex) {
  return knex.schema.dropTableIfExists('users')
}
